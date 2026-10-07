// 撞球桌幾何與物理模擬。伺服器用它做權威模擬，瀏覽器用它的幾何資料繪圖與瞄準輔助線。
//
// 座標系：x 向右、y 為桌面另一軸（俯視時向下），z 指向桌面下方（右手座標系）。
// 每顆球有線速度 v=(vx,vy) 與角速度 w=(wx,wy,wz)。球與檯布接觸點相對球心為 (0,0,R)，
// 接觸點滑動速度 u = v + w×r；滑動時摩擦力讓球逐漸進入純滾動，這就是定桿、拉桿、跟桿的來源。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Physics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const W = 1000;            // 檯面寬（內框）
  const H = 500;             // 檯面高
  const R = 11;              // 球半徑
  const CORNER_GAP = 32;     // 角袋開口：庫邊從角落算起多遠才開始
  const SIDE_GAP = 22;       // 中袋開口半寬
  const MAX_SPEED = 2200;    // 最大出桿速度（單位/秒）
  const ROLL_DECEL = 190;    // 滾動摩擦減速度
  const SLIDE_DECEL = 620;   // 滑動摩擦減速度（決定塞的效果能維持多久）
  const SPIN_DECEL = 14;     // 側旋（左右塞）衰減，rad/s²
  const BALL_RESTITUTION = 0.95;
  const CUSHION_RESTITUTION = 0.8;
  const CUSHION_FRICTION = 0.22;
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
  function isPocketed(b) {
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) return true;
    for (const p of POCKETS) {
      const dx = b.x - p.x, dy = b.y - p.y;
      const hole = p.r + POCKET_HOLE_EXTRA;
      if (dx * dx + dy * dy < hole * hole) return true;
    }
    return false;
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

  // 模擬一桿。spinX：左右塞（右為正），spinY：高低桿（上為正），範圍為單位圓。
  // 回傳逐格位置與旋轉（30fps）、音效事件、首次碰撞球、落袋球。
  function simulateShot(ballsIn, angle, power, spinX = 0, spinY = 0) {
    const balls = ballsIn.map(b => ({
      id: b.id, x: b.x, y: b.y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0,
      potted: b.potted, q: (b.q || [0, 0, 0, 1]).slice(),
    }));
    const cue = balls[0];
    const speed = Math.max(0.02, Math.min(1, power)) * MAX_SPEED;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let sl = Math.hypot(spinX, spinY);
    if (sl > 1) { spinX /= sl; spinY /= sl; }
    const a = spinX * MAX_TIP_OFFSET, b = spinY * MAX_TIP_OFFSET;
    cue.vx = dx * speed; cue.vy = dy * speed;
    // 偏心擊球的角衝量：ω = 5v/(2R) · (−b·ŝ − a·ẑ)，ŝ=(−dy,dx) 為擊球者右方
    const k = (5 * speed) / (2 * R);
    cue.wx = k * b * dy;
    cue.wy = -k * b * dx;
    cue.wz = -k * a;

    const DT = 1 / 480, RECORD_EVERY = 16, MAX_STEPS = 480 * 25;
    const frames = [], events = [];
    let firstHit = null;
    const pottedOrder = [];
    const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
    const record = () => {
      const f = [];
      for (const b of balls) {
        if (b.potted) f.push(null, null, null, null, null, null);
        else f.push(r1(b.x), r1(b.y), r3(b.q[0]), r3(b.q[1]), r3(b.q[2]), r3(b.q[3]));
      }
      frames.push(f);
    };
    record();

    for (let step = 1; step <= MAX_STEPS; step++) {
      let moving = false;
      for (const b of balls) {
        if (b.potted) continue;
        // 接觸點滑動速度
        const ux = b.vx + R * b.wy, uy = b.vy - R * b.wx;
        const us = Math.hypot(ux, uy);
        const sp = Math.hypot(b.vx, b.vy);
        if (sp < 2 && us < 2) {
          b.vx = b.vy = b.wx = b.wy = 0;
        } else {
          moving = true;
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
            const ns = Math.max(0, sp - (ROLL_DECEL + sp * 0.12) * DT);
            if (sp > 0) { b.vx *= ns / sp; b.vy *= ns / sp; }
            b.wx = b.vy / R; b.wy = -b.vx / R;
          }
        }
        if (b.wz) b.wz -= Math.sign(b.wz) * Math.min(Math.abs(b.wz), (SPIN_DECEL + Math.abs(b.wz) * 0.3) * DT);
        b.x += b.vx * DT; b.y += b.vy * DT;
        rotateQuat(b.q, b.wx, b.wy, b.wz, DT);
      }
      if (!moving) break;
      const frameIdx = Math.floor(step / RECORD_EVERY);

      // 球與球碰撞（法向衝量，旋轉保留在各自球上）
      for (let i = 0; i < 16; i++) {
        const p = balls[i];
        if (p.potted) continue;
        for (let j = i + 1; j < 16; j++) {
          const o = balls[j];
          if (o.potted) continue;
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
          if (firstHit === null && (p.id === 0 || o.id === 0)) firstHit = p.id === 0 ? o.id : p.id;
          events.push({ f: frameIdx, t: 'b', v: Math.min(1, rel / 1500) });
        }
      }

      // 庫邊碰撞（含側旋造成的反彈角變化）與落袋
      for (const b of balls) {
        if (b.potted) continue;
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
          const jn = -(1 + CUSHION_RESTITUTION) * vn;
          // 接觸點（-R·n）的切向滑動速度
          const tx = -ny, ty = nx;
          const ut = (b.vx + R * b.wz * ny) * tx + (b.vy - R * b.wz * nx) * ty;
          let jt = -ut / 3.5;
          const maxJt = CUSHION_FRICTION * jn;
          if (jt > maxJt) jt = maxJt; else if (jt < -maxJt) jt = -maxJt;
          b.vx += jn * nx + jt * tx;
          b.vy += jn * ny + jt * ty;
          b.wz += (-5 * jt) / (2 * R);
          b.vx *= 0.97; b.vy *= 0.97;
          if (-vn > 40) events.push({ f: frameIdx, t: 'c', v: Math.min(1, -vn / 1500) });
        }
        if (isPocketed(b)) {
          b.potted = true; b.vx = b.vy = b.wx = b.wy = b.wz = 0;
          pottedOrder.push(b.id);
          events.push({ f: frameIdx, t: 'p', v: 1 });
        }
      }

      if (step % RECORD_EVERY === 0) record();
    }
    record();

    return {
      frames, events, firstHit, potted: pottedOrder,
      balls: balls.map(b => ({ id: b.id, x: b.x, y: b.y, potted: b.potted, q: b.q.map(r3) })),
    };
  }

  return {
    W, H, R, POCKETS, POCKET_HOLE_EXTRA, CUSHIONS, HEAD_X, FOOT_X, MAX_SPEED, MAX_TIP_OFFSET,
    rackBalls, simulateShot, closestOnSegment,
  };
});
