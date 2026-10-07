import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const {
  W, H, R, POCKETS, POCKET_HOLE_EXTRA, SLOPE_WIDTH, SLOPE_DEPTH, CUSHIONS, HEAD_X, FOOT_X, MAX_TIP_OFFSET, CUE_MAX_ELEVATION, RAIL_HEIGHT, CUSHION_HEIGHT, closestOnSegment,
} = window.Physics;
const RAIL = 46;
const CUSHION_H = CUSHION_HEIGHT;
const RAIL_TOP = RAIL_HEIGHT;
const COLORS = ['#f4f1e6', '#f2c500', '#1f4fd1', '#d42020', '#6a2c91', '#f07a00', '#13803d', '#7a1c1c', '#141414'];
const ballColor = id => COLORS[id > 8 ? id - 8 : id];
const groupOf = id => (id >= 1 && id <= 7 ? 'solid' : id >= 9 && id <= 15 ? 'stripe' : null);

const $ = id => document.getElementById(id);

// ---------- 狀態 ----------
let ws = null;
let session = loadSession();
let state = null;          // 伺服器最新狀態
let inFlight = null;       // 進行中那一桿的 shotId（從出桿到套用伺服器結果）
let endState = null;       // 伺服器送來的這一桿結果，等本地播完再套用
let balls = [];            // 目前畫面上的球 {id,x,y,potted,q,sink}
let anim = null;           // 進行中的本地物理回放 { shot, start, shotId, local, nextEvent, pottedAt }
let aimAngle = Math.PI;
let power = 0;
let spinX = 0, spinY = 0;  // 擊球點：右為正、上為正（單位圓）
let pointerMode = null;    // 'place' | 'pull' | 'aim' | 'bar'
let pullStart = null;
let charging = null;       // 空白鍵蓄力開始時間
let shotPending = false;
let oppAim = null;
let cueBlocked = false;   // 目前瞄準方向的球桿是否被其他球擋住
let lastAimSent = 0;
let muted = localStorage.getItem('pool_muted') === '1';

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem('pool_session')); } catch { return null; }
}
function saveSession(s) {
  session = s;
  try { s ? sessionStorage.setItem('pool_session', JSON.stringify(s)) : sessionStorage.removeItem('pool_session'); } catch {}
}

// ---------- 連線 ----------
let pendingAction = null;
let reconnectTimer = null;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => {
    if (session) send({ type: 'resume', code: session.code, token: session.token });
    else if (pendingAction) { send(pendingAction); pendingAction = null; }
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (session) {
      setMessage('連線中斷，重新連線中…');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    } else ws = null;
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function act(msg) {
  if (ws && ws.readyState === 1) send(msg);
  else { pendingAction = msg; if (!ws) connect(); }
}

function handle(msg) {
  switch (msg.type) {
    case 'joined':
      // （重新）連上時丟掉進行中的回放，等伺服器送來的最新狀態
      anim = null; inFlight = null; endState = null; shotPending = false;
      saveSession({ code: msg.code, token: msg.token });
      history.replaceState(null, '', '?room=' + msg.code);
      showGame();
      break;
    case 'resumeFailed':
      saveSession(null);
      showLobby();
      break;
    case 'error':
      if ($('lobby').classList.contains('hidden')) toast(msg.message);
      else $('lobbyError').textContent = msg.message;
      // 自己先開始播的這一桿被伺服器拒絕：取消並還原
      if (anim && anim.local) {
        anim = null; inFlight = null; endState = null;
        balls = state.game.balls.map(b => ({ ...b, q: (b.q || [0, 0, 0, 1]).slice(), sink: 0 }));
      }
      shotPending = false;
      break;
    case 'state':
      // 一桿進行中時，舊的遊戲狀態不能蓋掉正在播的球；只更新玩家連線資訊
      if (inFlight !== null) { if (state) { state.players = msg.players; renderHud(); } }
      else applyState(msg);
      break;
    case 'shotStart':
      if (inFlight === msg.shotId) break; // 自己出的桿，本地已經在播（或已播完）
      if (anim || endState) finishShot(true);                     // 上一桿還沒播完（例如分頁在背景），直接跳到結果
      startShot(msg, false);
      break;
    case 'shotEnd':
      if (inFlight === msg.shotId) { endState = msg.state; if (!anim) finishShot(); }
      else applyState(msg.state);
      break;
    case 'aim':
      oppAim = msg;
      break;
    case 'chat':
      addChat(msg.name, msg.text, msg.seat === (state && state.you) ? 'me' : '');
      break;
    case 'notice':
      addChat('', msg.text, 'sys');
      toast(msg.text);
      break;
  }
}

function applyState(s) {
  const prev = state;
  state = s;
  const g = s.game;
  if (g) {
    const newShot = !prev || !prev.game || prev.game.shotId !== g.shotId;
    if (newShot || !isMyTurn() || !g.ballInHand) balls = g.balls.map(b => ({ ...b, q: (b.q || [0, 0, 0, 1]).slice(), sink: 0 }));
    if (newShot) { oppAim = null; if (isMyTurn()) camYaw = aimAngle = defaultAim(); }
  } else {
    balls = []; // 對手離開，房間回到等待狀態
    oppAim = null;
  }
  // 對手連線狀態的系統訊息
  if (prev && prev.players && s.players) {
    const opp = 1 - s.you;
    const was = prev.players[opp], now = s.players[opp];
    if (!was && now) addChat('', `${now.name} 加入了房間`, 'sys');
    else if (was && now && was.connected && !now.connected) addChat('', `${now.name} 已斷線，等待重新連線…`, 'sys');
    else if (was && now && !was.connected && now.connected) addChat('', `${now.name} 重新連線了`, 'sys');
  }
  renderHud();
}

function defaultAim() {
  // 預設朝最近的目標球
  const cue = balls[0];
  let best = null, bd = Infinity;
  for (const b of balls) {
    if (b.id === 0 || b.potted) continue;
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bd) { bd = d; best = b; }
  }
  return best ? Math.atan2(best.y - cue.y, best.x - cue.x) : 0;
}

// ---------- 畫面切換與 HUD ----------
function showLobby() {
  $('lobby').classList.remove('hidden');
  $('game').classList.add('hidden');
  const code = parseCode(new URLSearchParams(location.search).get('room') || '');
  const invited = code.length === 6;
  if (invited) $('codeInput').value = code;
  // 從邀請連結進來：提示直接加入，避免誤按「建立房間」
  $('inviteNote').classList.toggle('hidden', !invited);
  $('inviteCode').textContent = code;
  updateLobbyButtons();
  if (invited) $('nameInput').focus();
}
function showGame() {
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  resize();
}

const isMyTurn = () => !!(state && state.game && state.game.phase === 'playing' && state.game.turn === state.you && state.players[1]);
const canShoot = () => isMyTurn() && !anim && !shotPending;

function inviteLink() {
  return location.origin + location.pathname + '?room=' + (state ? state.code : '');
}

function renderHud() {
  if (!state) return;
  $('roomCode').textContent = state.code;
  $('bigCode').textContent = state.code;
  const g = state.game;
  $('waitOverlay').classList.toggle('hidden', !!state.players[1]);
  if (!g) { $('overOverlay').classList.add('hidden'); setMessage(''); }

  for (let i = 0; i < 2; i++) {
    const el = $('p' + i);
    const p = state.players[i];
    el.querySelector('.name').textContent = p ? p.name + (i === state.you ? '（你）' : '') : '等待加入…';
    el.querySelector('.dot').classList.toggle('on', !!(p && p.connected));
    el.classList.toggle('turn', !!(g && g.phase === 'playing' && g.turn === i));
    const group = g && g.groups[i];
    el.querySelector('.pgroup').textContent = !g ? '' : group ? (group === 'solid' ? '全色球 1–7' : '花色球 9–15') : '尚未分組';
    const chips = el.querySelector('.chips');
    chips.innerHTML = '';
    if (g && group) {
      const left = g.balls.filter(b => !b.potted && groupOf(b.id) === group).map(b => b.id);
      if (!left.length && !g.balls[8].potted) left.push(8);
      for (const id of left) chips.appendChild(chip(id));
    }
  }

  if (g) {
    let m = g.message || '';
    if (g.phase === 'playing' && state.players[1]) {
      const turnText = g.turn === state.you ? '輪到你' : `輪到 ${state.players[g.turn].name}`;
      m = `${m}　—　${turnText}${g.ballInHand && g.turn === state.you ? '（可拖曳白球擺放）' : ''}`;
    }
    setMessage(m);
    const over = g.phase === 'over';
    $('overOverlay').classList.toggle('hidden', !over);
    if (over) {
      $('overTitle').textContent = g.winner === state.you ? '🏆 你贏了！' : `${state.players[g.winner].name} 獲勝`;
      $('overReason').textContent = g.message;
      const r = g.rematch || [false, false];
      $('rematchBtn').disabled = r[state.you];
      $('rematchBtn').textContent = r[state.you] ? '已準備' : '再來一局';
      $('rematchHint').textContent = r[1 - state.you] ? '對手想再來一局！' : r[state.you] ? '等待對手確認…' : '';
    }
  }
  updatePowerBar();
}

function chip(id) {
  const el = document.createElement('span');
  el.className = 'chip';
  const c = ballColor(id);
  el.style.background = id > 8 ? `linear-gradient(#fff 0 25%, ${c} 25% 75%, #fff 75%)` : c;
  el.innerHTML = `<b>${id}</b>`;
  return el;
}

function setMessage(t) { $('message').textContent = t; }

let toastTimer;
function toast(t) {
  const el = $('toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function addChat(name, text, cls) {
  const log = $('chatLog');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = name ? `${name}：${text}` : text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`已複製${label}`); }
  catch { prompt(`複製${label}：`, text); }
}

// ---------- 音效 ----------
let audio = null;
function ensureAudio() {
  if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  if (audio && audio.state === 'suspended') audio.resume();
}
function playSound(type, v) {
  if (muted || !audio) return;
  const t = audio.currentTime;
  const gain = audio.createGain();
  gain.connect(audio.destination);
  if (type === 'b' || type === 'cue') {
    const len = 0.04;
    const buf = audio.createBuffer(1, audio.sampleRate * len, audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
    const src = audio.createBufferSource();
    src.buffer = buf;
    const f = audio.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = type === 'cue' ? 1400 : 2600; f.Q.value = 1.2;
    src.connect(f); f.connect(gain);
    gain.gain.value = 0.15 + 0.85 * v;
    src.start(t);
  } else {
    const o = audio.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(type === 'p' ? 120 : 180, t);
    o.frequency.exponentialRampToValueAtTime(type === 'p' ? 50 : 90, t + 0.18);
    gain.gain.setValueAtTime((type === 'p' ? 0.5 : 0.35) * Math.max(0.2, v), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (type === 'p' ? 0.3 : 0.15));
    o.connect(gain);
    o.start(t); o.stop(t + 0.35);
  }
}

// =====================================================================
// 3D 場景。桌面座標 (x, y) 對應到 three.js 的 (X, Z)，Y 軸朝上，檯布表面 Y=0。
// =====================================================================
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.localClippingEnabled = true;
view.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070d0a);
scene.fog = new THREE.Fog(0x070d0a, 2200, 4500);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(42, 16 / 9, 1, 8000);
const controls = new OrbitControls(camera, canvas);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 120;
controls.maxDistance = 2600;
controls.maxPolarAngle = Math.PI * 0.48;
controls.target.set(W / 2, 0, H / 2);

// 燈光：撞球檯上方吊燈
scene.add(new THREE.HemisphereLight(0xfff6e0, 0x1a2a1f, 0.45));
const lamp = new THREE.SpotLight(0xfff3dd, 2.4, 0, 0.62, 0.55, 0);
lamp.position.set(W / 2, 1100, H / 2);
lamp.target.position.set(W / 2, 0, H / 2);
lamp.castShadow = true;
lamp.shadow.mapSize.set(2048, 2048);
lamp.shadow.camera.near = 600;
lamp.shadow.camera.far = 1500;
lamp.shadow.bias = -0.0004;
lamp.shadow.radius = 4;
scene.add(lamp, lamp.target);
for (const x of [W * 0.18, W * 0.82]) {
  const s = new THREE.SpotLight(0xfff0d8, 0.7, 0, 0.6, 0.7, 0);
  s.position.set(x, 900, H / 2);
  s.target.position.set(x, 0, H / 2);
  scene.add(s, s.target);
}

// 平面輪廓（x, y）擠出成立體，頂面位於 top 高度
function extrude(shape, depth, top, mat, bevel = 0) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 24,
  });
  geo.rotateX(Math.PI / 2); // shape (x,y) → (x,0,y)，擠出方向朝下
  geo.translate(0, top - bevel, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// 外框矩形（-16 內縮）與袋口圓的交界輪廓：inside=true 給檯布用（袋口凹進），false 給木框內緣用（袋口凸出）
function tableOutline(inside, extra = 0) {
  const L = -16, T = -16, Rt = W + 16, B = H + 16;
  const PW = Rt - L, PH = B - T, P = 2 * (PW + PH);
  const perim = (x, y) => {
    if (Math.abs(y - T) < 1e-6) return x - L;
    if (Math.abs(x - Rt) < 1e-6) return PW + (y - T);
    if (Math.abs(y - B) < 1e-6) return PW + PH + (Rt - x);
    return 2 * PW + PH + (B - y);
  };
  const s0 = perim(W / 4, T);
  const rel = s => (s - s0 + P) % P;
  const inRect = (x, y) => x > L && x < Rt && y > T && y < B;
  const items = [];
  for (const c of [[L, T], [Rt, T], [Rt, B], [L, B]]) items.push({ s: rel(perim(c[0], c[1])), pts: [c] });
  const cuts = [];
  for (const p of POCKETS) {
    const r = p.r + POCKET_HOLE_EXTRA + extra;
    const hits = [];
    for (const [ex, ey, horiz] of [[0, T, 1], [0, B, 1], [L, 0, 0], [Rt, 0, 0]]) {
      const d = horiz ? ey - p.y : ex - p.x;
      if (Math.abs(d) >= r) continue;
      const h = Math.sqrt(r * r - d * d);
      for (const sgn of [-1, 1]) {
        const x = horiz ? p.x + sgn * h : ex, y = horiz ? ey : p.y + sgn * h;
        if (x >= L - 1e-6 && x <= Rt + 1e-6 && y >= T - 1e-6 && y <= B + 1e-6) hits.push([x, y]);
      }
    }
    hits.sort((a, b) => rel(perim(...a)) - rel(perim(...b)));
    const [en, ex] = [hits[0], hits[hits.length - 1]];
    const a0 = Math.atan2(en[1] - p.y, en[0] - p.x);
    let delta = (Math.atan2(ex[1] - p.y, ex[0] - p.x) - a0 + Math.PI * 4) % (Math.PI * 2);
    const mid = a0 + delta / 2;
    if (inRect(p.x + Math.cos(mid) * r, p.y + Math.sin(mid) * r) !== inside) delta -= Math.PI * 2;
    const pts = [];
    for (let i = 0; i <= 20; i++) { const a = a0 + (delta * i) / 20; pts.push([p.x + Math.cos(a) * r, p.y + Math.sin(a) * r]); }
    const sEn = rel(perim(...en)), sEx = rel(perim(...ex));
    cuts.push([sEn, sEx]);
    items.push({ s: sEn, pts });
  }
  // 移除落在袋口範圍內的矩形角
  const kept = items.filter(it => it.pts.length > 1 || !cuts.some(([a, b]) => it.s > a && it.s < b));
  kept.sort((a, b) => a.s - b.s);
  const pts = [[W / 4, T]];
  for (const it of kept) pts.push(...it.pts);
  return pts.map(([x, y]) => new THREE.Vector2(x, y));
}

function woodTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#5a2c12'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 140; i++) {
    g.strokeStyle = `rgba(${Math.random() < 0.5 ? '30,12,4' : '120,62,28'},${0.08 + Math.random() * 0.18})`;
    g.lineWidth = 1 + Math.random() * 3;
    g.beginPath();
    const y = Math.random() * 512;
    g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x / 60 + i) * 6);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(0.004, 0.004);
  return t;
}

function feltTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#16773f'; g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(0.02, 0.02);
  return t;
}

function buildTable() {
  const feltMat = new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95, metalness: 0 });
  const cushionMat = new THREE.MeshStandardMaterial({ color: 0x15703c, roughness: 0.9 });
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.42, metalness: 0.05 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x2b1408, roughness: 0.6 });

  // 檯布
  // 檯布挖洞比袋口大一圈，那一圈改成向下的斜面
  extrude(new THREE.Shape(tableOutline(true, SLOPE_WIDTH)), 12, 0, feltMat).castShadow = false;
  const slopeMat = feltMat.clone();
  slopeMat.side = THREE.DoubleSide;
  for (const p of POCKETS) {
    const hole = p.r + POCKET_HOLE_EXTRA;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(hole + SLOPE_WIDTH, hole, SLOPE_DEPTH, 48, 1, true), slopeMat);
    ring.position.set(p.x, -SLOPE_DEPTH / 2, p.y);
    ring.receiveShadow = true;
    scene.add(ring);
  }

  // 木框（外圓角矩形挖掉內緣與袋口）
  const outer = new THREE.Shape();
  const x0 = -RAIL, y0 = -RAIL, x1 = W + RAIL, y1 = H + RAIL, rr = 26;
  outer.moveTo(x0 + rr, y0); outer.lineTo(x1 - rr, y0); outer.quadraticCurveTo(x1, y0, x1, y0 + rr);
  outer.lineTo(x1, y1 - rr); outer.quadraticCurveTo(x1, y1, x1 - rr, y1);
  outer.lineTo(x0 + rr, y1); outer.quadraticCurveTo(x0, y1, x0, y1 - rr);
  outer.lineTo(x0, y0 + rr); outer.quadraticCurveTo(x0, y0, x0 + rr, y0);
  outer.holes.push(new THREE.Path(tableOutline(false)));
  extrude(outer, 60, RAIL_TOP, woodMat, 2.5);

  // 庫邊（依物理線段與袋角）
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  const jaws = CUSHIONS.slice(6);
  for (let i = 0; i < 6; i++) {
    const [ax, ay, bx, by] = CUSHIONS[i];
    const ja = jaws.find(s => same([s[0], s[1]], [ax, ay]));
    const jb = jaws.find(s => same([s[0], s[1]], [bx, by]));
    const pts = [[ax, ay], [bx, by], [jb[2], jb[3]], [ja[2], ja[3]]].map(([x, y]) => new THREE.Vector2(x, y));
    extrude(new THREE.Shape(pts), CUSHION_H + 2, CUSHION_H, cushionMat, 0);
  }

  // 袋口：黑色內襯蓋住木框的切面。檯面範圍內、斜面底部以上的部分剪掉，讓球從斜面落入
  const L = -16, T = -16, Rt = W + 16, B = H + 16;
  const holeMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.8, side: THREE.DoubleSide, clipIntersection: true,
    clippingPlanes: [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), -SLOPE_DEPTH),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), L), new THREE.Plane(new THREE.Vector3(1, 0, 0), -Rt),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), T), new THREE.Plane(new THREE.Vector3(0, 0, 1), -B),
    ],
  });
  const bottomMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  for (const p of POCKETS) {
    const r = p.r + POCKET_HOLE_EXTRA;
    const top = RAIL_TOP + 1, bot = -55;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(r - 2.8, r - 3.5, top - bot, 40, 1, true), holeMat);
    tube.position.set(p.x, (top + bot) / 2, p.y);
    scene.add(tube);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(r, 32), bottomMat);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(p.x, -50, p.y);
    scene.add(bottom);
  }

  // 菱形標記
  const dotMat = new THREE.MeshStandardMaterial({ color: 0xf1e3c4, roughness: 0.3, metalness: 0.2 });
  const dotGeo = new THREE.CircleGeometry(2.8, 4);
  const addDot = (x, y) => {
    const m = new THREE.Mesh(dotGeo, dotMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, RAIL_TOP + 0.6, y);
    scene.add(m);
  };
  for (let k = 1; k < 8; k++) { if (k !== 4) { addDot((W / 8) * k, -RAIL / 2 - 8); addDot((W / 8) * k, H + RAIL / 2 + 8); } }
  for (let k = 1; k < 4; k++) { addDot(-RAIL / 2 - 8, (H / 4) * k); addDot(W + RAIL / 2 + 8, (H / 4) * k); }

  // 開球線與置球點
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false });
  const head = new THREE.Mesh(new THREE.PlaneGeometry(1.4, H), lineMat);
  head.rotation.x = -Math.PI / 2;
  head.position.set(HEAD_X, 0.15, H / 2);
  scene.add(head);
  for (const x of [HEAD_X, FOOT_X]) {
    const s = new THREE.Mesh(new THREE.CircleGeometry(2.5, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    s.rotation.x = -Math.PI / 2;
    s.position.set(x, 0.2, H / 2);
    scene.add(s);
  }

  // 桌身、桌腳、地板
  const body = new THREE.Mesh(new THREE.BoxGeometry(W + RAIL * 2 - 24, 80, H + RAIL * 2 - 24), darkWood);
  body.position.set(W / 2, -85, H / 2);
  body.castShadow = body.receiveShadow = true;
  scene.add(body);
  for (const [x, z] of [[-RAIL + 40, -RAIL + 40], [W + RAIL - 40, -RAIL + 40], [-RAIL + 40, H + RAIL - 40], [W + RAIL - 40, H + RAIL - 40], [W / 2, -RAIL + 40], [W / 2, H + RAIL - 40]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(46, 300, 46), darkWood);
    leg.position.set(x, -270, z);
    leg.castShadow = true;
    scene.add(leg);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: 0x2a1c16, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -420;
  floor.receiveShadow = true;
  scene.add(floor);
}
buildTable();

// ---------- 球 ----------
function ballTexture(id) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const col = ballColor(id);
  if (id === 0) {
    g.fillStyle = COLORS[0]; g.fillRect(0, 0, 1024, 512);
    // 練習用白球上的紅點，讓旋轉看得出來
    g.fillStyle = '#c8202a';
    for (const x of [0, 256, 512, 768, 1024]) { g.beginPath(); g.arc(x, 256, 22, 0, Math.PI * 2); g.fill(); }
    g.fillRect(0, 0, 1024, 14); g.fillRect(0, 498, 1024, 14);
  } else {
    g.fillStyle = id > 8 ? COLORS[0] : col;
    g.fillRect(0, 0, 1024, 512);
    if (id > 8) { g.fillStyle = col; g.fillRect(0, 150, 1024, 212); }
    for (const x of [256, 768]) {
      g.fillStyle = '#f7f4ea';
      g.beginPath(); g.arc(x, 256, 62, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#111';
      g.font = `bold ${id > 9 ? 64 : 76}px Arial, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(id), x, 260);
      if (id === 6 || id === 9) g.fillRect(x - 18, 300, 36, 6); // 底線區分 6 與 9
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

const ballGeo = new THREE.SphereGeometry(R, 48, 32);
const ballMeshes = [];
for (let id = 0; id < 16; id++) {
  const mat = new THREE.MeshPhysicalMaterial({ map: ballTexture(id), roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.06 });
  const m = new THREE.Mesh(ballGeo, mat);
  m.castShadow = true;
  scene.add(m);
  ballMeshes.push(m);
}
// 貼圖上號碼在 +Z 方向，基準旋轉讓號碼一開始朝上
const BASE_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const tmpQ = new THREE.Quaternion();

function updateBallMeshes() {
  for (let id = 0; id < 16; id++) {
    const m = ballMeshes[id];
    const b = balls[id];
    if (!b || b.potted) { m.visible = false; continue; }
    m.visible = true;
    // 在袋口斜面上時球跟著往下沉一點
    m.position.set(b.x, R - window.Physics.surfaceDrop(b.x, b.y) - (b.sink || 0) * 2.2 * R, b.y);
    const q = b.q || [0, 0, 0, 1];
    // 物理座標 (x, y, z朝下) → three (X, Y朝上, Z)
    tmpQ.set(q[0], -q[2], q[1], q[3]);
    m.quaternion.multiplyQuaternions(tmpQ, BASE_Q);
  }
}

// ---------- 瞄準輔助、球桿 ----------
const aimGroup = new THREE.Group();
scene.add(aimGroup);
const mkLine = (color, opacity, dashed) => {
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 7, gapSize: 6, transparent: true, opacity, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), mat);
  line.frustumCulled = false;
  aimGroup.add(line);
  return line;
};
const aimLine = mkLine(0xffffff, 0.85, true);
const objLine = mkLine(0xffe58a, 0.95, false);
const cueLine = mkLine(0xffffff, 0.55, false);
const ghost = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
aimGroup.add(ghost);

function setLine(line, x1, y1, x2, y2, h = 0.8) {
  const pos = line.geometry.attributes.position;
  pos.setXYZ(0, x1, h, y1); pos.setXYZ(1, x2, h, y2);
  pos.needsUpdate = true;
  if (line.material.isLineDashedMaterial) line.computeLineDistances();
}

// 球桿：本地 +Y 指向桿頭，桿頭位於原點
const cueStick = new THREE.Group();
{
  const parts = [
    [2, 1.3, 1.3, 0x2f6fd6],   // 皮頭
    [9, 1.35, 1.4, 0xf2f0e8],  // 先角
    [235, 1.4, 2.3, 0xe4c48a], // 前節
    [8, 2.3, 2.4, 0x1a1a1a],   // 接牙
    [150, 2.4, 3.3, 0x3a1a0a], // 後節
    [4, 3.3, 3.3, 0x111111],   // 尾蓋
  ];
  let y = 0;
  for (const [len, rTop, rBot, color] of parts) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, 20), new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05 }));
    m.position.y = y - len / 2;
    m.castShadow = true;
    cueStick.add(m);
    y -= len;
  }
}
scene.add(cueStick);
const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
const BLOCKED_GLOW = new THREE.Color(0xff1a1a), NO_GLOW = new THREE.Color(0x000000);

// 擺放球桿；白球後方有障礙時自動抬高桿尾，抬到極限仍會碰到球則標成紅色並回傳 true（無法出桿）
function placeCue(cx, cy, angle, pw, sx, sy, opacity) {
  const elevation = window.Physics.cueElevation(balls, angle, sx, sy);
  const blocked = elevation > CUE_MAX_ELEVATION;
  const e = Math.min(elevation, CUE_MAX_ELEVATION);
  const d = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  const right = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
  const a = sx * MAX_TIP_OFFSET * R, b = sy * MAX_TIP_OFFSET * R;
  const depth = Math.sqrt(Math.max(0, R * R - a * a - b * b));
  const stickDir = tmpV.copy(d).multiplyScalar(Math.cos(e)).addScaledVector(UP, -Math.sin(e)).normalize();
  const tip = tmpV2.set(cx, R, cy).addScaledVector(right, a).addScaledVector(UP, b).addScaledVector(d, -depth)
    .addScaledVector(stickDir, -(3 + pw * 90));
  cueStick.position.copy(tip);
  cueStick.quaternion.setFromUnitVectors(UP, stickDir);
  cueStick.visible = true;
  cueStick.traverse(o => {
    if (!o.material) return;
    o.material.transparent = opacity < 1;
    o.material.opacity = opacity;
    o.material.emissive.copy(blocked ? BLOCKED_GLOW : NO_GLOW);
    o.material.emissiveIntensity = blocked ? 1.2 : 0;
  });
  return blocked;
}

// 沿瞄準方向找出第一顆會碰到的球或庫邊（桌面座標）
function traceAim(cx, cy, angle) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let tHit = Infinity, hitBall = null;
  for (const b of balls) {
    if (b.id === 0 || b.potted) continue;
    const ox = cx - b.x, oy = cy - b.y;
    const bq = ox * dx + oy * dy;
    const c = ox * ox + oy * oy - 4 * R * R;
    const disc = bq * bq - c;
    if (disc < 0) continue;
    const t = -bq - Math.sqrt(disc);
    if (t > 0 && t < tHit) { tHit = t; hitBall = b; }
  }
  const limit = Math.min(tHit, 2500);
  for (let t = 0; t < limit; t += 2) {
    const px = cx + dx * t, py = cy + dy * t;
    if (px < -R || px > W + R || py < -R || py > H + R) return { t, ball: null };
    for (const s of CUSHIONS) {
      const [qx, qy] = closestOnSegment(px, py, s);
      if ((px - qx) ** 2 + (py - qy) ** 2 < R * R) return { t, ball: null };
    }
  }
  return { t: tHit, ball: hitBall };
}

function updateAim(cx, cy, angle, faded) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const { t, ball } = traceAim(cx, cy, angle);
  const gx = cx + dx * t, gy = cy + dy * t;
  aimGroup.visible = true;
  const k = faded ? 0.5 : 1;
  aimLine.material.opacity = 0.85 * k;
  setLine(aimLine, cx + dx * R, cy + dy * R, gx, gy);
  ghost.position.set(gx, R, gy);
  ghost.material.opacity = 0.22 * k;
  objLine.visible = cueLine.visible = !!ball;
  if (ball) {
    // 目標球前進方向（黃線，長度依撞擊厚薄）與白球分離方向（白線）
    const nx = (ball.x - gx) / (2 * R), ny = (ball.y - gy) / (2 * R);
    const dot = dx * nx + dy * ny;
    objLine.material.opacity = 0.95 * k;
    setLine(objLine, ball.x, ball.y, ball.x + nx * (110 * dot + 20), ball.y + ny * (110 * dot + 20));
    const tx = dx - dot * nx, ty = dy - dot * ny;
    cueLine.visible = Math.hypot(tx, ty) > 0.05;
    cueLine.material.opacity = 0.55 * k;
    setLine(cueLine, gx, gy, gx + tx * 70, gy + ty * 70);
  }
}

// 自由球擺放提示
const placeRing = new THREE.Mesh(new THREE.RingGeometry(R + 3, R + 5.5, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
placeRing.rotation.x = -Math.PI / 2;
scene.add(placeRing);
const breakZone = new THREE.Mesh(new THREE.PlaneGeometry(HEAD_X, H), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false }));
breakZone.rotation.x = -Math.PI / 2;
breakZone.position.set(HEAD_X / 2, 0.3, H / 2);
scene.add(breakZone);

// ---------- 鏡頭 ----------
let camMode = 'free';
let camTween = null;
// 球桿視角：鏡頭繞著白球，方向 camYaw 與瞄準方向分開（避免滑鼠瞄準時鏡頭跟著轉而互相追逐）
let cuePitch = 0.2, cueDist = 260, camYaw = 0;

function presetFor(mode) {
  const aspect = camera.aspect;
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  if (mode === 'top') {
    const d = Math.max((W + RAIL * 2) / (2 * tan * aspect), (H + RAIL * 2) / (2 * tan)) * 1.04;
    return { pos: new THREE.Vector3(W / 2, d, H / 2 + 1), target: new THREE.Vector3(W / 2, 0, H / 2) };
  }
  const d = Math.max(900, (W + RAIL * 2) / (2 * tan * aspect) * 0.95);
  return { pos: new THREE.Vector3(W / 2, d * 0.62, H / 2 + d * 0.78), target: new THREE.Vector3(W / 2, -20, H / 2) };
}

function cueCamera(angle) {
  const cue = balls[0];
  const d = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  const c = new THREE.Vector3(cue.x, R, cue.y);
  return {
    pos: c.clone().addScaledVector(d, -cueDist * Math.cos(cuePitch)).addScaledVector(UP, cueDist * Math.sin(cuePitch) + 8),
    target: c.clone().addScaledVector(d, 160).setY(0),
  };
}

function setCamMode(mode) {
  camMode = mode;
  try { localStorage.setItem('pool_cam', mode); } catch {}
  document.querySelectorAll('.cam-btn').forEach(b => b.classList.toggle('active', b.dataset.cam === mode));
  const hasCue = balls[0] && !balls[0].potted;
  if (mode === 'cue') camYaw = currentAimAngle();
  const to = mode === 'cue' && hasCue ? cueCamera(camYaw) : presetFor(mode === 'cue' ? 'free' : mode);
  camTween = { fromPos: camera.position.clone(), fromTarget: controls.target.clone(), to, t0: performance.now(), dur: 650 };
}

function updateCamera(now) {
  if (camTween) {
    const k = Math.min(1, (now - camTween.t0) / camTween.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (camMode === 'cue' && balls[0] && !balls[0].potted) camTween.to = cueCamera(camYaw);
    camera.position.lerpVectors(camTween.fromPos, camTween.to.pos, e);
    controls.target.lerpVectors(camTween.fromTarget, camTween.to.target, e);
    camera.lookAt(controls.target);
    if (k >= 1) camTween = null;
    controls.enabled = false;
    return;
  }
  if (camMode === 'cue') {
    controls.enabled = false;
    // 動畫播放時鏡頭停住；其餘時間待在白球後方（右鍵拖曳可繞著白球轉）
    // 擺放自由球時也先停住，否則鏡頭跟著白球移動會讓游標下的位置一直變
    if (!anim && pointerMode !== 'place' && balls[0] && !balls[0].potted) {
      const to = cueCamera(camYaw);
      camera.position.lerp(to.pos, 0.25);
      controls.target.lerp(to.target, 0.25);
    }
    camera.lookAt(controls.target);
  } else {
    controls.enabled = true;
    controls.update();
  }
}

function currentAimAngle() {
  if (!isMyTurn() && oppAim) return oppAim.angle;
  return aimAngle;
}

document.querySelectorAll('.cam-btn').forEach(b => b.addEventListener('click', () => setCamMode(b.dataset.cam)));

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

// ---------- 一桿的即時物理回放 ----------
// 出桿後在瀏覽器裡用與伺服器相同的物理逐步推進（邊算邊播），不必等伺服器回傳。
// 播完後套用伺服器送來的權威結果（同為 V8 引擎時兩邊算出來完全一樣）。
const SINK_TIME = 0.25; // 落袋後滑進洞裡的動畫秒數

function startShot(p, local) {
  oppAim = null;
  power = 0; updatePowerBar();
  inFlight = p.shotId;
  endState = null;
  anim = {
    shot: window.Physics.createShot(p.start, p.angle, p.power, p.spinX, p.spinY, p.isBreak),
    start: performance.now(), shotId: p.shotId, local, nextEvent: 0, pottedAt: {},
  };
  showSimBalls(0);
}

// 推進物理到目前時間；回傳 true 表示整桿（含落袋動畫）已播完
function stepShot(now) {
  const { shot } = anim;
  const target = Math.max(0, (now - anim.start) / 1000);
  while (!shot.done && shot.time < target) shot.step();
  const { events } = shot;
  while (anim.nextEvent < events.length && events[anim.nextEvent].t <= target) {
    const ev = events[anim.nextEvent++];
    playSound(ev.type, ev.v);
  }
  showSimBalls(target);
  return shot.done && target >= shot.time + SINK_TIME;
}

function showSimBalls(t) {
  balls = anim.shot.balls.map(b => {
    if (!b.potted) return { id: b.id, x: b.x, y: b.y, potted: false, q: b.q, sink: 0 };
    // 剛落袋：滑向袋口並往下掉
    if (anim.pottedAt[b.id] === undefined) anim.pottedAt[b.id] = Math.min(t, anim.shot.time);
    const k = (t - anim.pottedAt[b.id]) / SINK_TIME;
    if (k >= 1) return { id: b.id, x: 0, y: 0, potted: true };
    const p = nearestPocket(b.x, b.y);
    return { id: b.id, x: b.x + (p.x - b.x) * k, y: b.y + (p.y - b.y) * k, potted: false, q: b.q, sink: Math.max(0, k) };
  });
}

// 套用伺服器的結果。skip=true 時表示直接跳過剩下的回放
function finishShot(skip) {
  if (skip && anim) { while (anim.shot.step()); }
  anim = null;
  const s = endState;
  endState = null;
  inFlight = null;
  shotPending = false;
  if (s) applyState(s);
}

function nearestPocket(x, y) {
  let best = POCKETS[0], bd = Infinity;
  for (const p of POCKETS) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
  return best;
}

// ---------- 主迴圈 ----------
function render(now) {
  requestAnimationFrame(render);
  if ($('game').classList.contains('hidden')) return;
  if (anim && stepShot(now)) {
    // 本地播完：伺服器結果已到就套用，還沒到就停在最後畫面等它
    anim = null;
    if (endState) finishShot();
  }
  if (charging !== null) {
    if (canShoot()) { power = Math.min(1, (now - charging) / 1400); updatePowerBar(); sendAim(); }
    else charging = null;
  }
  updateBallMeshes();

  const g = state && state.game;
  const cue = balls[0];
  aimGroup.visible = false;
  cueStick.visible = false;
  placeRing.visible = false;
  breakZone.visible = false;
  let blocked = false;
  if (g && g.phase === 'playing' && !anim && cue && !cue.potted) {
    if (canShoot()) {
      if (g.ballInHand) {
        placeRing.visible = true;
        placeRing.position.set(cue.x, 0.4, cue.y);
        placeRing.material.color.set(cueValid(cue.x, cue.y) ? 0xffffff : 0xff5050);
        breakZone.visible = g.isBreak;
      }
      if (pointerMode !== 'place') {
        updateAim(cue.x, cue.y, aimAngle, false);
        blocked = placeCue(cue.x, cue.y, aimAngle, power, spinX, spinY, 1);
      }
    } else if (!isMyTurn() && oppAim) {
      if (g.ballInHand) { cue.x = oppAim.cueX; cue.y = oppAim.cueY; updateBallMeshes(); }
      updateAim(cue.x, cue.y, oppAim.angle, true);
      placeCue(cue.x, cue.y, oppAim.angle, oppAim.power, oppAim.spinX || 0, oppAim.spinY || 0, 0.75);
    }
  }
  if (blocked !== cueBlocked) { cueBlocked = blocked; $('cueWarn').classList.toggle('hidden', !blocked); }
  updateCamera(now);
  renderer.render(scene, camera);
}

function cueValid(x, y) {
  const g = state.game;
  if (x < R || x > W - R || y < R || y > H - R) return false;
  if (g.isBreak && x > HEAD_X) return false;
  return balls.every(b => b.id === 0 || b.potted || Math.hypot(b.x - x, b.y - y) >= 2 * R);
}

// ---------- 輸入 ----------
const raycaster = new THREE.Raycaster();
const ballPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();

function toTable(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(ballPlane, hit)) return null;
  return { x: hit.x, y: hit.z };
}

function aimAt(p) {
  const cue = balls[0];
  if (p && Math.hypot(p.x - cue.x, p.y - cue.y) > 2) aimAngle = Math.atan2(p.y - cue.y, p.x - cue.x);
}

function sendAim(force) {
  const now = performance.now();
  if (!force && now - lastAimSent < 50) return;
  lastAimSent = now;
  send({ type: 'aim', angle: aimAngle, power, cueX: balls[0].x, cueY: balls[0].y, spinX, spinY });
}

// 瞄準方向在螢幕上的單位向量（CSS 像素）；拉桿力道依螢幕上的拖曳距離計算，各視角手感一致
const projA = new THREE.Vector3(), projB = new THREE.Vector3();
function screenAimDir() {
  const cue = balls[0];
  const r = canvas.getBoundingClientRect();
  projA.set(cue.x, R, cue.y).project(camera);
  projB.set(cue.x + Math.cos(aimAngle) * 60, R, cue.y + Math.sin(aimAngle) * 60).project(camera);
  const dx = (projB.x - projA.x) * r.width / 2, dy = -(projB.y - projA.y) * r.height / 2;
  const len = Math.hypot(dx, dy);
  return len > 8 ? { x: dx / len, y: dy / len } : null;
}

// 球桿視角下的右鍵拖曳（繞白球旋轉、調整高低）、雙指縮放
const touches = new Map();
let rightDrag = null;

canvas.addEventListener('pointerdown', e => {
  ensureAudio();
  if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (camMode === 'cue' && (e.button === 2 || touches.size === 2)) {
    rightDrag = { x: e.clientX, y: e.clientY };
    if (touches.size === 2) { pointerMode = null; power = 0; updatePowerBar(); }
    return;
  }
  if (touches.size > 1) { pointerMode = null; return; } // 兩指交給 OrbitControls 旋轉縮放
  if (e.button !== 0 || !canShoot()) return;
  const p = toTable(e);
  const cue = balls[0];
  canvas.setPointerCapture(e.pointerId);
  if (state.game.ballInHand && p && Math.hypot(p.x - cue.x, p.y - cue.y) < R * 2.2) {
    pointerMode = 'place';
  } else if (e.pointerType === 'mouse') {
    if (!p) return;
    pointerMode = 'pull';
    aimAt(p);
    pullStart = { x: e.clientX, y: e.clientY, dir: screenAimDir(), table: p };
    power = 0;
  } else {
    pointerMode = 'aim';
    aimAt(p);
  }
  sendAim(true);
});

canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const prev = touches.get(e.pointerId);
    if (camMode === 'cue' && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [c, d] = [...touches.values()];
      const after = Math.hypot(c.x - d.x, c.y - d.y);
      cueDist = THREE.MathUtils.clamp(cueDist * before / Math.max(1, after), 90, 700);
      cuePitch = THREE.MathUtils.clamp(cuePitch + (e.clientY - prev.y) * 0.003, 0.03, 1.3);
      camYaw += (e.clientX - prev.x) * 0.0025;
      return;
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  if (rightDrag) {
    camYaw += (e.clientX - rightDrag.x) * 0.005;
    cuePitch = THREE.MathUtils.clamp(cuePitch + (e.clientY - rightDrag.y) * 0.004, 0.03, 1.3);
    rightDrag.x = e.clientX;
    rightDrag.y = e.clientY;
    return;
  }
  if (!canShoot()) return;
  const p = toTable(e);
  if (pointerMode === 'pull') {
    let back;
    if (pullStart.dir) back = -((e.clientX - pullStart.x) * pullStart.dir.x + (e.clientY - pullStart.y) * pullStart.dir.y) / 180;
    else if (p) back = -((p.x - pullStart.table.x) * Math.cos(aimAngle) + (p.y - pullStart.table.y) * Math.sin(aimAngle)) / 220;
    else return;
    power = Math.max(0, Math.min(1, back));
    updatePowerBar();
    sendAim();
    return;
  }
  if (!p) return;
  if (pointerMode === 'place') {
    balls[0].x = Math.max(R, Math.min(state.game.isBreak ? HEAD_X : W - R, p.x));
    balls[0].y = Math.max(R, Math.min(H - R, p.y));
  } else if (pointerMode === 'aim' || (!pointerMode && e.pointerType === 'mouse' && !e.buttons)) {
    aimAt(p);
  } else return;
  sendAim();
});

function endPointer(e) {
  touches.delete(e.pointerId);
  if (rightDrag && (e.button === 2 || e.pointerType === 'touch')) { if (touches.size < 2) rightDrag = null; return; }
  const mode = pointerMode;
  pointerMode = null;
  if (mode === 'pull') {
    if (power > 0.02) shoot();
    else { power = 0; updatePowerBar(); }
  }
  if (mode === 'place' && !cueValid(balls[0].x, balls[0].y)) toast('白球不能和其他球重疊');
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', e => { touches.delete(e.pointerId); rightDrag = null; pointerMode = null; power = 0; updatePowerBar(); });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  if (camMode !== 'cue') return;
  e.preventDefault();
  cueDist = THREE.MathUtils.clamp(cueDist * Math.exp(e.deltaY * 0.001), 90, 700);
}, { passive: false });

// 力道條（觸控友善）
const bar = $('powerBar');
function barPower(e) {
  const r = bar.getBoundingClientRect();
  power = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  updatePowerBar();
  sendAim();
}
bar.addEventListener('pointerdown', e => {
  ensureAudio();
  if (!canShoot()) return;
  bar.setPointerCapture(e.pointerId);
  pointerMode = 'bar';
  barPower(e);
});
bar.addEventListener('pointermove', e => { if (pointerMode === 'bar') barPower(e); });
bar.addEventListener('pointerup', () => {
  if (pointerMode !== 'bar') return;
  pointerMode = null;
  if (power > 0.02) shoot(); else { power = 0; updatePowerBar(); }
});
bar.addEventListener('pointercancel', () => { pointerMode = null; power = 0; updatePowerBar(); });

function updatePowerBar() {
  $('powerFill').style.width = (power * 100).toFixed(1) + '%';
  bar.classList.toggle('disabled', !canShoot());
  const isBreak = !!(state && state.game && state.game.isBreak);
  const label = (isBreak ? '開球力道加成' : '力道') + (power > 0 ? ` ${Math.round(power * 100)}%` : '（拖動後放開擊球）');
  if ($('powerLabel').textContent !== label) $('powerLabel').textContent = label;
}

function shoot() {
  const g = state.game;
  const cue = balls[0];
  if (window.Physics.isCueBlocked(balls, aimAngle, spinX, spinY)) {
    toast('球桿會碰到其他球，換個角度或擊球點');
    power = 0; updatePowerBar();
    return;
  }
  if (g.ballInHand && !cueValid(cue.x, cue.y)) {
    toast('白球位置不合法，請重新擺放');
    power = 0; updatePowerBar();
    return;
  }
  shotPending = true;
  playSound('cue', power);
  const params = { shotId: g.shotId, angle: aimAngle, power, spinX, spinY, isBreak: g.isBreak };
  send({
    type: 'shoot', ...params,
    cueX: g.ballInHand ? cue.x : undefined, cueY: g.ballInHand ? cue.y : undefined,
  });
  // 不等伺服器，立刻用同樣的物理在本地開始播（起始狀態與伺服器收到的一致）
  startShot({ ...params, start: balls.map(b => ({ id: b.id, x: b.x, y: b.y, potted: b.potted, q: (b.q || [0, 0, 0, 1]).slice() })) }, true);
  setSpin(0, 0);
  updatePowerBar();
}

function fine(delta) {
  if (!canShoot()) return;
  aimAngle += delta;
  sendAim(true);
}
function holdRepeat(btn, delta) {
  let timer;
  const stop = () => clearInterval(timer);
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    fine(delta);
    timer = setInterval(() => fine(delta), 60);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
}
holdRepeat($('fineLeft'), -0.002);
holdRepeat($('fineRight'), 0.002);

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    fine((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.02 : 0.003));
  } else if (e.code === 'Space') {
    e.preventDefault();
    ensureAudio();
    if (!e.repeat && canShoot()) charging = performance.now();
  }
});
window.addEventListener('keyup', e => {
  if (e.code !== 'Space' || charging === null) return;
  charging = null;
  if (canShoot() && power > 0.02) shoot(); else { power = 0; updatePowerBar(); }
});

// ---------- 加塞選擇器 ----------
const spinPad = $('spinPad');
const spinCtx = spinPad.getContext('2d');
function drawSpinPad() {
  const s = spinPad.width, c = s / 2, r = s * 0.44;
  spinCtx.clearRect(0, 0, s, s);
  const grad = spinCtx.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#bdb8a8');
  spinCtx.fillStyle = grad;
  spinCtx.beginPath(); spinCtx.arc(c, c, r, 0, Math.PI * 2); spinCtx.fill();
  spinCtx.strokeStyle = 'rgba(0,0,0,.18)'; spinCtx.lineWidth = 2;
  spinCtx.beginPath(); spinCtx.moveTo(c - r, c); spinCtx.lineTo(c + r, c); spinCtx.moveTo(c, c - r); spinCtx.lineTo(c, c + r); spinCtx.stroke();
  spinCtx.beginPath(); spinCtx.arc(c, c, r * 0.8, 0, Math.PI * 2); spinCtx.stroke();
  spinCtx.fillStyle = '#d4202a';
  spinCtx.beginPath(); spinCtx.arc(c + spinX * r * 0.8, c - spinY * r * 0.8, s * 0.07, 0, Math.PI * 2); spinCtx.fill();
  const v = spinY > 0.15 ? '跟桿' : spinY < -0.15 ? '拉桿' : '';
  const h = spinX > 0.15 ? '右塞' : spinX < -0.15 ? '左塞' : '';
  $('spinLabel').textContent = [v, h].filter(Boolean).join('+') || '中心';
}
function setSpin(x, y) {
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  spinX = x; spinY = y;
  drawSpinPad();
}
function spinFromEvent(e) {
  const r = spinPad.getBoundingClientRect();
  const k = (r.width * 0.44 * 0.8);
  setSpin((e.clientX - r.left - r.width / 2) / k, -(e.clientY - r.top - r.height / 2) / k);
  sendAim();
}
let spinDragging = false;
spinPad.addEventListener('pointerdown', e => { spinDragging = true; spinPad.setPointerCapture(e.pointerId); spinFromEvent(e); });
spinPad.addEventListener('pointermove', e => { if (spinDragging) spinFromEvent(e); });
spinPad.addEventListener('pointerup', () => { spinDragging = false; });
spinPad.addEventListener('dblclick', () => { setSpin(0, 0); sendAim(true); });
drawSpinPad();

// ---------- 按鈕 ----------
const nameInput = $('nameInput');
nameInput.value = localStorage.getItem('pool_name') || '';
const myName = () => {
  const n = nameInput.value.trim() || '玩家';
  localStorage.setItem('pool_name', n);
  return n;
};

$('roomCode').onclick = () => copy(state.code, '邀請碼');
$('copyCode').onclick = () => copy(state.code, '邀請碼');
$('copyLink').onclick = () => copy(inviteLink(), '邀請連結');
$('copyLinkSmall').onclick = () => copy(inviteLink(), '邀請連結');
$('rematchBtn').onclick = () => send({ type: 'rematch' });

const muteBtn = $('muteBtn');
const syncMute = () => { muteBtn.textContent = muted ? '🔇' : '🔊'; };
syncMute();
muteBtn.onclick = () => { ensureAudio(); muted = !muted; localStorage.setItem('pool_muted', muted ? '1' : '0'); syncMute(); };

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('chatInput');
  if (input.value.trim()) send({ type: 'chat', text: input.value });
  input.value = '';
});

$('leaveBtn').onclick = () => {
  if (!confirm('確定要離開這個房間嗎？')) return;
  send({ type: 'leave' });
  saveSession(null);
  state = null; anim = null; inFlight = null; endState = null; balls = [];
  $('chatLog').innerHTML = '';
  $('overOverlay').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  $('codeInput').value = '';
  showLobby();
};

// ---------- 大廳：邀請碼輸入 ----------
const codeInput = $('codeInput');
const createBtn = $('createBtn'), joinBtn = $('joinBtn');
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// 從邀請碼或整段邀請連結中取出 6 碼
function parseCode(text) {
  const m = String(text).match(/room=([A-Za-z0-9]{6})/);
  if (m) return m[1].toUpperCase();
  return String(text).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
}

function updateLobbyButtons() {
  const hasCode = codeInput.value.length === 6;
  joinBtn.classList.toggle('primary', hasCode);
  createBtn.classList.toggle('primary', !hasCode);
}

function doJoin() {
  ensureAudio();
  const code = parseCode(codeInput.value);
  if (code.length !== 6) { $('lobbyError').textContent = '邀請碼是 6 個字元'; return; }
  $('lobbyError').textContent = '';
  act({ type: 'join', code, name: myName() });
}

createBtn.onclick = () => {
  ensureAudio();
  const code = parseCode(codeInput.value);
  if (code.length === 6 && confirm(`你已經輸入了邀請碼 ${code}，要加入這個房間嗎？\n\n按「取消」則改為建立一個新房間。`)) return doJoin();
  $('lobbyError').textContent = '';
  act({ type: 'create', name: myName() });
};
joinBtn.onclick = doJoin;
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
codeInput.addEventListener('input', () => { codeInput.value = parseCode(codeInput.value); updateLobbyButtons(); });

// 邀請碼不小心貼到暱稱欄時，自動移到邀請碼欄
nameInput.addEventListener('paste', e => {
  const text = (e.clipboardData || window.clipboardData).getData('text').trim();
  if (!/room=/.test(text) && !CODE_RE.test(text)) return;
  e.preventDefault();
  codeInput.value = parseCode(text);
  updateLobbyButtons();
  toast('已把邀請碼填到「邀請碼」欄位，按「加入」即可');
  joinBtn.focus();
});

// ---------- 啟動 ----------
// 同一個瀏覽器分頁若已在別的房間，打開別人的邀請連結時不要回到舊房間
const urlCode = parseCode(new URLSearchParams(location.search).get('room') || '');
if (session && urlCode.length === 6 && urlCode !== session.code) saveSession(null);

// 「複製分頁」會連 sessionStorage 一起複製，造成兩個分頁搶同一個座位；偵測到就讓新分頁回大廳
const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('pool_tabs') : null;
if (tabs) tabs.onmessage = e => {
  if (e.data && e.data.type === 'who' && session && e.data.token === session.token && ws) tabs.postMessage({ type: 'mine', token: session.token });
};

function isSessionUsedElsewhere() {
  if (!tabs || !session) return Promise.resolve(false);
  return new Promise(resolve => {
    const token = session.token;
    const onMsg = e => { if (e.data && e.data.type === 'mine' && e.data.token === token) done(true); };
    const done = v => { tabs.removeEventListener('message', onMsg); clearTimeout(timer); resolve(v); };
    tabs.addEventListener('message', onMsg);
    const timer = setTimeout(() => done(false), 250);
    tabs.postMessage({ type: 'who', token });
  });
}

isSessionUsedElsewhere().then(dup => {
  if (dup) {
    const code = session.code;
    saveSession(null);
    showLobby();
    codeInput.value = code;
    updateLobbyButtons();
    toast('這個房間已在另一個分頁開啟，你可以用邀請碼以第二位玩家加入');
    return;
  }
  if (session) { connect(); setMessage('連線中…'); showGame(); }
  else showLobby();
});
resize();
{
  let saved = 'free';
  try { saved = localStorage.getItem('pool_cam') || 'free'; } catch {}
  const p = presetFor(saved === 'top' ? 'top' : 'free');
  camera.position.copy(p.pos);
  controls.target.copy(p.target);
  setCamMode(saved);
}
requestAnimationFrame(render);
