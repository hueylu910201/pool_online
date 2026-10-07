const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('./public/physics.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ROOM_TTL_MS = 10 * 60 * 1000; // 雙方都離線後保留房間多久

// ---------- 靜態檔案 ----------
const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  // /vendor/three/... 對應到 node_modules/three
  const [baseDir, rel] = urlPath.startsWith('/vendor/three/')
    ? [THREE_DIR, urlPath.slice('/vendor/three/'.length)]
    : [PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath];
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- 房間 ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I O 0 1

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newCode(),
    players: [null, null], // { name, token, ws }
    breaker: 0,
    game: null,
    cleanupTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function newGame(breaker) {
  return {
    balls: P.rackBalls(),
    turn: breaker,
    groups: [null, null], // 'solid' | 'stripe'
    ballInHand: true,
    isBreak: true,
    phase: 'playing',
    winner: null,
    message: '開球！',
    shotId: 0,
  };
}

const groupOf = id => (id >= 1 && id <= 7 ? 'solid' : id >= 9 && id <= 15 ? 'stripe' : null);
const groupName = g => (g === 'solid' ? '全色球 (1-7)' : '花色球 (9-15)');

function remaining(game, group) {
  return game.balls.filter(b => !b.potted && groupOf(b.id) === group).length;
}

function freeSpot(balls, x, y, dir = -1) {
  // 找一個不與其他球重疊的位置（沿 x 方向移動）
  let px = x;
  for (let tries = 0; tries < 200; tries++) {
    const ok = balls.every(b => b.potted || Math.hypot(b.x - px, b.y - y) >= 2 * P.R + 0.5);
    if (ok && px > P.R && px < P.W - P.R) return { x: px, y };
    px += dir * 2;
    if (px <= P.R || px >= P.W - P.R) { dir = -dir; px = x; }
  }
  return { x, y };
}

function validCuePlacement(game, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < P.R || x > P.W - P.R || y < P.R || y > P.H - P.R) return false;
  if (game.isBreak && x > P.HEAD_X) return false;
  return game.balls.every(b => b.id === 0 || b.potted || Math.hypot(b.x - x, b.y - y) >= 2 * P.R);
}

// 依 8 號球規則判定一桿的結果
function applyRules(game, shooter, sim, names) {
  const opp = 1 - shooter;
  const myGroup = game.groups[shooter];
  const wasBreak = game.isBreak;
  const clearedBefore = myGroup && remaining(game, myGroup) === 0;
  const potted = sim.potted;
  const cuePotted = potted.includes(0);
  const eightPotted = potted.includes(8);
  const objPotted = potted.filter(id => id !== 0 && id !== 8);

  let foul = null;
  if (cuePotted) foul = '白球落袋';
  else if (sim.firstHit === null) foul = '白球沒有碰到任何球';
  else if (!wasBreak) {
    if (myGroup) {
      const target = clearedBefore ? 8 : null;
      if (target === 8 && sim.firstHit !== 8) foul = '應先碰 8 號球';
      else if (!target && groupOf(sim.firstHit) !== myGroup) foul = '先碰到的不是自己的球';
    } else if (sim.firstHit === 8) foul = '不能先碰 8 號球';
  }

  game.balls = sim.balls;
  game.isBreak = false;
  game.shotId++;

  // 8 號球
  if (eightPotted) {
    if (wasBreak) {
      const spot = freeSpot(game.balls, P.FOOT_X, P.H / 2, 1);
      Object.assign(game.balls[8], spot, { potted: false });
    } else {
      game.phase = 'over';
      if (clearedBefore && !foul) {
        game.winner = shooter;
        game.message = '8 號球進袋，獲勝！';
      } else {
        game.winner = opp;
        game.message = foul ? `打進 8 號球但犯規（${foul}），判負` : '提早打進 8 號球，判負';
      }
      return;
    }
  }

  // 分組（開球後的第一顆合法進球決定）
  let assignedNow = false;
  if (!foul && !wasBreak && !myGroup && objPotted.length) {
    const g = groupOf(objPotted[0]);
    game.groups[shooter] = g;
    game.groups[opp] = g === 'solid' ? 'stripe' : 'solid';
    assignedNow = true;
  }

  if (cuePotted) {
    const spot = freeSpot(game.balls, P.HEAD_X, P.H / 2);
    Object.assign(game.balls[0], spot, { potted: false });
  }

  const group = game.groups[shooter];
  const pottedOwn = group ? objPotted.some(id => groupOf(id) === group) : objPotted.length > 0;

  if (foul) {
    game.turn = opp;
    game.ballInHand = true;
    game.message = `犯規：${foul}，對手自由球`;
  } else if (pottedOwn) {
    game.ballInHand = false;
    game.message = assignedNow ? `分組確定：${names[shooter]} 打${groupName(group)}，繼續` : '進球，繼續擊球';
  } else {
    game.turn = opp;
    game.ballInHand = false;
    game.message = objPotted.length ? '沒有打進自己的球，換人' : '沒有進球，換人';
  }
}

// ---------- 通訊 ----------
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptSeat = -1) {
  room.players.forEach((p, i) => { if (p && i !== exceptSeat) send(p.ws, msg); });
}

function stateFor(room, seat) {
  const g = room.game;
  return {
    type: 'state',
    code: room.code,
    you: seat,
    players: room.players.map(p => (p ? { name: p.name, connected: !!(p.ws && p.ws.readyState === 1) } : null)),
    game: g && {
      balls: g.balls, turn: g.turn, groups: g.groups, ballInHand: g.ballInHand,
      isBreak: g.isBreak, phase: g.phase, winner: g.winner, message: g.message, shotId: g.shotId,
      remaining: [g.groups[0] ? remaining(g, g.groups[0]) : null, g.groups[1] ? remaining(g, g.groups[1]) : null],
      rematch: g.rematch || [false, false],
    },
  };
}

function sendStates(room) {
  room.players.forEach((p, i) => { if (p) send(p.ws, stateFor(room, i)); });
}

function scheduleCleanup(room) {
  clearTimeout(room.cleanupTimer);
  const anyOnline = room.players.some(p => p && p.ws && p.ws.readyState === 1);
  if (!anyOnline) room.cleanupTimer = setTimeout(() => rooms.delete(room.code), ROOM_TTL_MS);
}

function attach(ws, room, seat) {
  const p = room.players[seat];
  if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch {} }
  p.ws = ws;
  ws.room = room;
  ws.seat = seat;
  clearTimeout(room.cleanupTimer);
  send(ws, { type: 'joined', code: room.code, token: p.token, seat });
  sendStates(room);
}

const cleanName = n => (String(n || '').trim().slice(0, 16) || '玩家');

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const room = ws.room;
    const seat = ws.seat;

    switch (msg.type) {
      case 'create': {
        if (room) return;
        const r = createRoom();
        r.players[0] = { name: cleanName(msg.name), token: crypto.randomUUID(), ws: null };
        attach(ws, r, 0);
        break;
      }
      case 'join': {
        if (room) return;
        const r = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!r) return send(ws, { type: 'error', message: '找不到這個邀請碼的房間' });
        if (r.players[1]) return send(ws, { type: 'error', message: '房間已滿' });
        r.players[1] = { name: cleanName(msg.name), token: crypto.randomUUID(), ws: null };
        r.game = newGame(r.breaker);
        attach(ws, r, 1);
        break;
      }
      case 'resume': {
        if (room) return;
        const r = rooms.get(String(msg.code || '').toUpperCase());
        const s = r ? r.players.findIndex(p => p && p.token === msg.token) : -1;
        if (s < 0) return send(ws, { type: 'resumeFailed' });
        attach(ws, r, s);
        break;
      }
      case 'aim': {
        const g = room && room.game;
        if (!g || g.phase !== 'playing' || g.turn !== seat) return;
        broadcast(room, {
          type: 'aim', angle: +msg.angle || 0, power: Math.max(0, Math.min(1, +msg.power || 0)),
          cueX: +msg.cueX || 0, cueY: +msg.cueY || 0,
          spinX: Math.max(-1, Math.min(1, +msg.spinX || 0)), spinY: Math.max(-1, Math.min(1, +msg.spinY || 0)),
        }, seat);
        break;
      }
      case 'shoot': {
        const g = room && room.game;
        if (!g || g.phase !== 'playing' || g.turn !== seat || !room.players[1 - seat]) return;
        if (msg.shotId !== g.shotId) return; // 舊的或重複的出桿
        const angle = +msg.angle, power = +msg.power;
        if (!Number.isFinite(angle) || !Number.isFinite(power) || power <= 0) return;
        if (g.ballInHand && msg.cueX != null) {
          if (!validCuePlacement(g, +msg.cueX, +msg.cueY)) return send(ws, { type: 'error', message: '白球位置不合法' });
          g.balls[0].x = +msg.cueX; g.balls[0].y = +msg.cueY;
        }
        const spinX = Math.max(-1, Math.min(1, +msg.spinX || 0));
        const spinY = Math.max(-1, Math.min(1, +msg.spinY || 0));
        const sim = P.simulateShot(g.balls, angle, power, spinX, spinY);
        applyRules(g, seat, sim, room.players.map(p => p.name));
        room.players.forEach((p, i) => {
          if (p) send(p.ws, { type: 'shot', shooter: seat, frames: sim.frames, events: sim.events, state: stateFor(room, i) });
        });
        break;
      }
      case 'chat': {
        if (!room) return;
        const text = String(msg.text || '').trim().slice(0, 120);
        if (text) broadcast(room, { type: 'chat', name: room.players[seat].name, text, seat });
        break;
      }
      case 'leave': {
        if (!room) return;
        const leaver = room.players[seat];
        room.players[seat] = null;
        ws.room = null;
        ws.seat = undefined;
        const other = room.players[1 - seat];
        if (!other) { clearTimeout(room.cleanupTimer); rooms.delete(room.code); break; }
        // 留下的玩家變成房主，房間回到等待狀態，邀請碼不變
        room.players = [other, null];
        if (other.ws) { other.ws.seat = 0; send(other.ws, { type: 'notice', text: `${leaver.name} 離開了房間，可以再邀請其他人` }); }
        room.game = null;
        room.breaker = 0;
        sendStates(room);
        scheduleCleanup(room);
        break;
      }
      case 'rematch': {
        const g = room && room.game;
        if (!g || g.phase !== 'over') return;
        g.rematch = g.rematch || [false, false];
        g.rematch[seat] = true;
        if (g.rematch[0] && g.rematch[1]) {
          room.breaker = 1 - room.breaker;
          room.game = newGame(room.breaker);
        }
        sendStates(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    const p = room.players[ws.seat];
    if (p && p.ws === ws) p.ws = null;
    sendStates(room);
    scheduleCleanup(room);
  });
});

server.listen(PORT, () => {
  console.log(`撞球伺服器已啟動： http://localhost:${PORT}`);
});
