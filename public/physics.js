// 撞球桌幾何與物理模擬。伺服器用它做權威模擬，瀏覽器用它的幾何資料繪圖與瞄準輔助線。
//
// 座標系：x 向右、y 為桌面另一軸（俯視時向下），z 指向桌面下方（右手座標系）。
// 每顆球有線速度 v=(vx,vy) 與角速度 w=(wx,wy,wz)。球與檯布接觸點相對球心為 (0,0,R)，
// 接觸點滑動速度 u = v + w×r；滑動時摩擦力讓球逐漸進入純滾動，這就是定桿、拉桿、跟桿的來源。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Physics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 伺服器與網頁之間的通訊協定版本；兩邊不一致時網頁會提示或自動重新整理
  const PROTOCOL = 4;

  const W = 1000;            // 檯面寬（內框）
  const H = 500;             // 檯面高
  const R = 11;              // 球半徑
  const CORNER_GAP = 32;     // 角袋開口：庫邊從角落算起多遠才開始
  const SIDE_GAP = 22;       // 中袋開口半寬
  const MAX_SPEED = 3200;        // 一般擊球的最大出桿速度（單位/秒，約 8 m/s）
  const MAX_BREAK_SPEED = 6000;  // 開球的最大出桿速度（約 15 m/s，接近真實大力開球）
  const POWER_CURVE = 1.2;       // 力道條略呈非線性：輕球好控制，但中段不會太弱
  const ROLL_DECEL = 70;     // 滾動摩擦減速度
  const SLIDE_DECEL = 620;   // 滑動摩擦減速度（決定塞的效果能維持多久）
  const SPIN_DECEL = 14;     // 側旋（左右塞）衰減，rad/s²
  const BALL_RESTITUTION = 0.95;
  // 庫邊反彈係數隨撞擊速度下降：輕碰約 0.75，大力撞約 0.55（橡膠吸收較多能量）
  const CUSHION_E_SLOW = 0.75, CUSHION_E_FAST = 0.55, CUSHION_E_SPEED = 2500;
  const CUSHION_FRICTION = 0.3;
  const CUSHION_SPIN_KEEP = 0.2; // 撞庫後保留的滾動旋轉比例（庫邊接觸點高於球心，吸收大部分前滾）
  const MAX_TIP_OFFSET = 0.5; // 擊球點最大偏離球心距離（R 的倍數）
  const HEAD_X = W * 0.25;   // 開球線
  const FOOT_X = W * 0.73;   // 置球點

  const POCKETS = [
    { x: -6, y: -6, r: 22 }, { x: W / 2, y: -10, r: 20 }, { x: W + 6, y: -6, r: 22 },
    { x: -6, y: H + 6, r: 22 }, { x: W / 2, y: H + 10, r: 20 }, { x: W + 6, y: H + 6, r: 22 },
  ];

  // 庫邊線段：前 6 條為主庫邊，其餘為袋口內側斜邊（袋角）
  const CUSHIONS = [
    [CORNER_GAP, 0, W / 2 - SIDE_GAP, 0],
    [W / 2 + SIDE_GAP, 0, W - CORNER_GAP, 0],
    [CORNER_GAP, H, W / 2 - SIDE_GAP, H],
    [W / 2 + SIDE_GAP, H, W - CORNER_GAP, H],
    [0, CORNER_GAP, 0, H - CORNER_GAP],
    [W, CORNER_GAP, W, H - CORNER_GAP],
    [CORNER_GAP, 0, CORNER_GAP - 14, -14], [0, CORNER_GAP, -14, CORNER_GAP - 14],
    [W - CORNER_GAP, 0, W - CORNER_GAP + 14, -14], [W, CORNER_GAP, W + 14, CORNER_GAP - 14],
    [CORNER_GAP, H, CORNER_GAP - 14, H + 14], [0, H - CORNER_GAP, -14, H - CORNER_GAP + 14],
    [W - CORNER_GAP, H, W - CORNER_GAP + 14, H + 14], [W, H - CORNER_GAP, W + 14, H - CORNER_GAP + 14],
    [W / 2 - SIDE_GAP, 0, W / 2 - SIDE_GAP + 4, -16], [W / 2 + SIDE_GAP, 0, W / 2 + SIDE_GAP - 4, -16],
    [W / 2 - SIDE_GAP, H, W / 2 - SIDE_GAP + 4, H + 16], [W / 2 + SIDE_GAP, H, W / 2 + SIDE_GAP - 4, H + 16],
  ];

  function closestOnSegment(px, py, s) {
    const [x1, y1, x2, y2] = s;
    const dx = x2 - x1, dy = y2 - y1;
    let t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return [x1 + dx * t, y1 + dy * t];
  }

  // 球心一越過袋口洞的邊緣（與畫面上檯布挖洞的半徑 r+3 一致）就會失去支撐而落袋
  const POCKET_HOLE_EXTRA = 3;
  // 袋口外圍一圈微微向下的斜面：寬 SLOPE_WIDTH、洞口邊比檯面低 SLOPE_DEPTH，球在上面會被拉向袋口
  const SLOPE_WIDTH = 9, SLOPE_DEPTH = 1.8, SLOPE_ACCEL = 260;

  // 若球在某個袋口斜面上，回傳 { nx, ny, k }：指向袋口中心的單位向量與位置（0=外緣、1=洞口邊）
  function onPocketSlope(x, y) {
    for (const p of POCKETS) {
      const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy);
      const hole = p.r + POCKET_HOLE_EXTRA;
      if (d >= hole && d < hole + SLOPE_WIDTH) return { nx: dx / d, ny: dy / d, k: 1 - (d - hole) / SLOPE_WIDTH };
    }
    return null;
  }
  // 畫面用：該位置的檯面比平面低多少
  const surfaceDrop = (x, y) => { const s = onPocketSlope(x, y); return s ? s.k * SLOPE_DEPTH : 0; };
  function isPocketed(b) {
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) return true;
    for (const p of POCKETS) {
      const dx = b.x - p.x, dy = b.y - p.y;
      const hole = p.r + POCKET_HOLE_EXTRA;
      if (dx * dx + dy * dy < hole * hole) return true;
    }
    return false;
  }

  // 從 (x, y) 開始沿 x 方向找一個不與其他（未落袋）球重疊的位置，用於白球放回、置球
  function findFreeSpot(balls, x, y, dir = -1) {
    let px = x;
    for (let tries = 0; tries < 200; tries++) {
      const ok = balls.every(b => b.potted || Math.hypot(b.x - px, b.y - y) >= 2 * R + 0.5);
      if (ok && px > R && px < W - R) return { x: px, y };
      px += dir * 2;
      if (px <= R || px >= W - R) { dir = -dir; px = x; }
    }
    return { x, y };
  }

  // 四元數 [x,y,z,w]：依世界座標角速度 w 旋轉 dt 秒
  function rotateQuat(q, wx, wy, wz, dt) {
    const ang = Math.hypot(wx, wy, wz) * dt;
    if (ang < 1e-9) return;
    const s = Math.sin(ang / 2) / (ang / dt), c = Math.cos(ang / 2);
    const ax = wx * s, ay = wy * s, az = wz * s;
    const [x, y, z, w] = q;
    q[0] = c * x + ax * w + ay * z - az * y;
    q[1] = c * y - ax * z + ay * w + az * x;
    q[2] = c * z + ax * y - ay * x + az * w;
    q[3] = c * w - ax * x - ay * y - az * z;
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
  }

  // 建立標準 8 號球三角排列
  function rackBalls() {
    const solids = [2, 3, 4, 5, 6, 7];
    const stripes = [10, 11, 12, 13, 14, 15];
    shuffle(solids); shuffle(stripes);
    // 底排兩角必須一全一花
    const cornerSolid = solids.pop(), cornerStripe = stripes.pop();
    const rest = shuffle(solids.concat(stripes, [9]));
    const order = [];
    let k = 0;
    for (let row = 0; row < 5; row++) {
      for (let j = 0; j <= row; j++) {
        if (row === 0) order.push(1);
        else if (row === 2 && j === 1) order.push(8);
        else if (row === 4 && j === 0) order.push(cornerSolid);
        else if (row === 4 && j === 4) order.push(cornerStripe);
        else order.push(rest[k++]);
      }
    }
    const balls = [];
    for (let i = 0; i < 16; i++) balls.push({ id: i, x: 0, y: 0, potted: false, q: [0, 0, 0, 1] });
    balls[0].x = HEAD_X; balls[0].y = H / 2;
    const gap = 0.2;
    let idx = 0;
    for (let row = 0; row < 5; row++) {
      for (let j = 0; j <= row; j++) {
        const id = order[idx++];
        balls[id].x = FOOT_X + row * (Math.sqrt(3) * (R + gap));
        balls[id].y = H / 2 + (j - row / 2) * 2 * (R + gap);
      }
    }
    return balls;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 物理步長：要夠細，最高速時每步移動距離仍小於球半徑，才不會穿過庫邊
  const DT = 1 / 720, MAX_STEPS = 720 * 25;
  // 離邊界超過這個距離的球不可能碰到庫邊、袋口或袋口斜面，可以跳過那些檢查
  const EDGE_MARGIN = R + 23;
  const nearEdge = b => b.x < EDGE_MARGIN || b.x > W - EDGE_MARGIN || b.y < EDGE_MARGIN || b.y > H - EDGE_MARGIN;
  const r3 = v => Math.round(v * 1000) / 1000;

  // 建立一桿的逐步模擬。spinX：左右塞（右為正），spinY：高低桿（上為正），範圍為單位圓。
  // 伺服器一次跑完取得權威結果；瀏覽器在每個畫面影格推進一點，邊算邊播，不必等整桿算完。
  // 同樣的輸入在伺服器與瀏覽器（同為 V8 引擎）會得到完全相同的結果。
  function createShot(ballsIn, angle, power, spinX = 0, spinY = 0, isBreak = false) {
    const balls = ballsIn.map(b => ({
      id: b.id, x: b.x, y: b.y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0,
      potted: b.potted, q: (b.q || [0, 0, 0, 1]).slice(),
    }));
    const cue = balls[0];
    const speed = Math.pow(Math.max(0.02, Math.min(1, power)), POWER_CURVE) * (isBreak ? MAX_BREAK_SPEED : MAX_SPEED);
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const sl = Math.hypot(spinX, spinY);
    if (sl > 1) { spinX /= sl; spinY /= sl; }
    const a = spinX * MAX_TIP_OFFSET, b = spinY * MAX_TIP_OFFSET;
    cue.vx = dx * speed; cue.vy = dy * speed;
    // 偏心擊球的角衝量：ω = 5v/(2R) · (−b·ŝ − a·ẑ)，ŝ=(−dy,dx) 為擊球者右方
    const k = (5 * speed) / (2 * R);
    cue.wx = k * b * dy;
    cue.wy = -k * b * dx;
    cue.wz = -k * a;

    const shot = { balls, steps: 0, time: 0, done: false, events: [], firstHit: null, potted: [], collided: false };

    // 推進一個物理步長；回傳 false 表示所有球都停了
    shot.step = () => {
      if (shot.done) return false;
      shot.collided = false;
      let moving = false;
      for (const b of balls) {
        if (b.potted) continue;
        // 接觸點滑動速度
        const ux = b.vx + R * b.wy, uy = b.vy - R * b.wx;
        const us = Math.hypot(ux, uy);
        const sp = Math.hypot(b.vx, b.vy);
        const slope = nearEdge(b) ? onPocketSlope(b.x, b.y) : null;
        if (slope) {
          b.vx += slope.nx * SLOPE_ACCEL * DT;
          b.vy += slope.ny * SLOPE_ACCEL * DT;
        }
        if (sp < 2 && us < 2 && !slope) {
          b.vx = b.vy = b.wx = b.wy = 0;
          b.asleep = true;
        } else {
          moving = true;
          b.asleep = false;
          if (us > 0.5) {
            // 滑動：摩擦力反向於滑動方向，同時改變線速度與角速度
            let dv = SLIDE_DECEL * DT;
            if (3.5 * dv > us) dv = us / 3.5;
            const fx = -ux / us * dv, fy = -uy / us * dv;
            b.vx += fx; b.vy += fy;
            b.wx += (5 / (2 * R)) * -fy;
            b.wy += (5 / (2 * R)) * fx;
          } else {
            // 純滾動
            const ns = Math.max(0, sp - (ROLL_DECEL + sp * 0.03) * DT);
            if (sp > 0) { b.vx *= ns / sp; b.vy *= ns / sp; }
            b.wx = b.vy / R; b.wy = -b.vx / R;
          }
        }
        if (b.wz) b.wz -= Math.sign(b.wz) * Math.min(Math.abs(b.wz), (SPIN_DECEL + Math.abs(b.wz) * 0.3) * DT);
        b.x += b.vx * DT; b.y += b.vy * DT;
        rotateQuat(b.q, b.wx, b.wy, b.wz, DT);
      }
      if (!moving || shot.steps >= MAX_STEPS) { shot.done = true; return false; }
      shot.steps++;
      const t = shot.time = shot.steps * DT;

      // 球與球碰撞（法向衝量，旋轉保留在各自球上）；兩顆都靜止的球不會互撞
      for (let i = 0; i < 16; i++) {
        const p = balls[i];
        if (p.potted) continue;
        for (let j = i + 1; j < 16; j++) {
          const o = balls[j];
          if (o.potted || (p.asleep && o.asleep)) continue;
          const ddx = o.x - p.x, ddy = o.y - p.y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= 4 * R * R || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const nx = ddx / d, ny = ddy / d;
          const rel = (p.vx - o.vx) * nx + (p.vy - o.vy) * ny;
          const overlap = 2 * R - d;
          p.x -= nx * overlap / 2; p.y -= ny * overlap / 2;
          o.x += nx * overlap / 2; o.y += ny * overlap / 2;
          if (rel <= 0) continue;
          const imp = rel * (1 + BALL_RESTITUTION) / 2;
          p.vx -= imp * nx; p.vy -= imp * ny;
          o.vx += imp * nx; o.vy += imp * ny;
          p.asleep = o.asleep = false;
          if (shot.firstHit === null && (p.id === 0 || o.id === 0)) shot.firstHit = p.id === 0 ? o.id : p.id;
          shot.events.push({ t, type: 'b', v: Math.min(1, rel / 1500) });
          shot.collided = true;
        }
      }

      // 庫邊碰撞（含側旋造成的反彈角變化）與落袋：只檢查靠近邊界的球
      for (const b of balls) {
        if (b.potted || !nearEdge(b)) continue;
        for (const s of CUSHIONS) {
          const [cx, cy] = closestOnSegment(b.x, b.y, s);
          const ddx = b.x - cx, ddy = b.y - cy;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= R * R || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const nx = ddx / d, ny = ddy / d;
          b.x = cx + nx * R; b.y = cy + ny * R;
          const vn = b.vx * nx + b.vy * ny;
          if (vn >= 0) continue;
          const e = CUSHION_E_SLOW - (CUSHION_E_SLOW - CUSHION_E_FAST) * Math.min(1, -vn / CUSHION_E_SPEED);
          const jn = -(1 + e) * vn;
          // 接觸點（-R·n）的切向滑動速度
          const tx = -ny, ty = nx;
          const ut = (b.vx + R * b.wz * ny) * tx + (b.vy - R * b.wz * nx) * ty;
          let jt = -ut / 3.5;
          const maxJt = CUSHION_FRICTION * jn;
          if (jt > maxJt) jt = maxJt; else if (jt < -maxJt) jt = -maxJt;
          b.vx += jn * nx + jt * tx;
          b.vy += jn * ny + jt * ty;
          b.wz += (-5 * jt) / (2 * R);
          b.wx *= CUSHION_SPIN_KEEP; b.wy *= CUSHION_SPIN_KEEP;
          if (-vn > 40) shot.events.push({ t, type: 'c', v: Math.min(1, -vn / 1500) });
          shot.collided = true;
        }
        if (isPocketed(b)) {
          // 記下落袋瞬間的速度與旋轉，讓畫面上的落袋動畫能接著滾下去（不影響物理結果）
          b.potV = [b.vx, b.vy, b.wx, b.wy, b.wz];
          b.potT = t;
          b.potted = true; b.vx = b.vy = b.wx = b.wy = b.wz = 0;
          shot.potted.push(b.id);
          shot.events.push({ t, type: 'p', v: 1 });
          shot.collided = true;
        }
      }
      return true;
    };

    // 最終結果（伺服器判定規則、存成下一桿起始狀態用）
    shot.result = () => ({
      events: shot.events, firstHit: shot.firstHit, potted: shot.potted, duration: shot.time,
      balls: balls.map(b => ({ id: b.id, x: b.x, y: b.y, potted: b.potted, q: b.q.map(r3) })),
    });
    return shot;
  }

  // 一次模擬完整一桿。opts.record=true 時另外回傳逐格位置（每格開頭為時間秒數，約 30fps，碰撞瞬間加關鍵格），供測試與除錯用
  function simulateShot(ballsIn, angle, power, spinX = 0, spinY = 0, isBreak = false, opts = {}) {
    const shot = createShot(ballsIn, angle, power, spinX, spinY, isBreak);
    const frames = opts.record ? [] : null;
    const RECORD_EVERY = 24;
    let lastRecord = 0;
    const record = () => {
      lastRecord = shot.steps;
      const f = [Math.round(shot.time * 10000) / 10000];
      for (const b of shot.balls) {
        if (b.potted) f.push(null, null, null, null, null, null);
        else f.push(Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, r3(b.q[0]), r3(b.q[1]), r3(b.q[2]), r3(b.q[3]));
      }
      frames.push(f);
    };
    if (frames) record();
    while (shot.step()) {
      if (frames && (shot.steps - lastRecord >= RECORD_EVERY || (shot.collided && shot.steps - lastRecord >= 3))) record();
    }
    if (frames) record();
    const res = shot.result();
    if (frames) res.frames = frames;
    return res;
  }

  // ---------- 球桿仰角 ----------
  // 白球後方有球或庫邊時，球桿必須抬高才不會穿過去。計算需要的最小仰角（弧度），
  // 超過 CUE_MAX_ELEVATION 代表這個角度打不到（例如緊貼在白球正後方的球）。
  const CUE_LENGTH = 408;
  const CUE_MIN_ELEVATION = 0.09;
  const CUE_MAX_ELEVATION = 0.6;  // 約 34°
  const RAIL_HEIGHT = 17;          // 木框頂面高度
  const CUSHION_HEIGHT = 15;       // 庫邊頂面高度
  const cueRadiusAt = s => 1.4 + (Math.max(0, s) / CUE_LENGTH) * 1.9;

  function cueElevation(balls, angle, spinX = 0, spinY = 0) {
    const cue = balls[0];
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const rx = -dy, ry = dx; // 擊球者右方
    const a = spinX * MAX_TIP_OFFSET * R, b = spinY * MAX_TIP_OFFSET * R;
    const depth = Math.sqrt(Math.max(0, R * R - a * a - b * b));
    const tipH = R + b; // 皮頭接觸點高度
    // 在球桿所在的垂直面上，球桿從皮頭 (0, tipH) 往後以仰角 e 延伸；
    // 要通過以 (s, h) 為圓心、半徑 rho 的障礙截面上方，需 (tipH-h)·cos e + s·sin e ≥ rho
    const needFor = (s, h, rho) => {
      const A = tipH - h, B = s, M = Math.hypot(A, B);
      if (rho >= M) return Infinity;
      return Math.asin(rho / M) - Math.atan2(A, B);
    };
    let need = CUE_MIN_ELEVATION;
    for (const o of balls) {
      if (o.id === 0 || o.potted) continue;
      const ox = o.x - cue.x, oy = o.y - cue.y;
      const s = -(ox * dx + oy * dy) - depth; // 障礙在皮頭後方多遠（水平）
      if (s < -R || s > CUE_LENGTH + R) continue;
      const lat = ox * rx + oy * ry - a;      // 與球桿的橫向距離
      const reach = R + cueRadiusAt(s);
      if (Math.abs(lat) >= reach) continue;
      need = Math.max(need, needFor(s, R, Math.sqrt(reach * reach - lat * lat)));
    }
    // 庫邊與木框：只會讓球桿抬高，不會擋住出桿（白球貼庫時實際上是往下壓著打）
    let tExit = Infinity;
    if (dx < 0) tExit = Math.min(tExit, (W - cue.x) / -dx); else if (dx > 0) tExit = Math.min(tExit, cue.x / dx);
    if (dy < 0) tExit = Math.min(tExit, (H - cue.y) / -dy); else if (dy > 0) tExit = Math.min(tExit, cue.y / dy);
    const sRail = tExit - depth;
    const railNeed = Math.max(
      needFor(Math.max(0.5, sRail), CUSHION_HEIGHT, cueRadiusAt(sRail)),
      needFor(sRail + 16, RAIL_HEIGHT, cueRadiusAt(sRail + 16)),
    );
    return Math.max(need, Math.min(railNeed, CUE_MAX_ELEVATION));
  }

  const isCueBlocked = (balls, angle, spinX, spinY) => cueElevation(balls, angle, spinX, spinY) > CUE_MAX_ELEVATION;

  return {
    PROTOCOL, W, H, R, POCKETS, POCKET_HOLE_EXTRA, SLOPE_WIDTH, SLOPE_DEPTH, CUSHIONS, HEAD_X, FOOT_X, MAX_SPEED, MAX_BREAK_SPEED, POWER_CURVE, MAX_TIP_OFFSET,
    CUE_LENGTH, CUE_MIN_ELEVATION, CUE_MAX_ELEVATION, RAIL_HEIGHT, CUSHION_HEIGHT,
    rackBalls, createShot, simulateShot, closestOnSegment, rotateQuat, findFreeSpot, cueElevation, isCueBlocked, surfaceDrop,
  };
});
