/* ============================================================
   CATnake — classic snake, but a black cat eating salmon.
   Self-contained game module. Expects the page to provide:
     - window.GameModal   { open(titleHtml), close(), body() }
     - window.Session     { loggedIn, username, tokens }
   and to route the modal's Exit button through this module's
   stop() before closing, so intervals don't keep running.
   ============================================================ */
const CATnake = (function () {

  /* ---------- 🎵 MUSIC — placeholder, not wired up yet ----------
     Once a track is picked, drop the file somewhere static (e.g.
     /uploads/catnake-theme.mp3) and uncomment these four lines,
     plus the playMusic()/stopMusic() calls further down (search
     "MUSIC HOOK").
  // const bgMusic = new Audio('/uploads/catnake-theme.mp3');
  // bgMusic.loop = true;
  // bgMusic.volume = 0.4;
  // function playMusic(){ bgMusic.play().catch(() => {}); }
  // function stopMusic(){ bgMusic.pause(); bgMusic.currentTime = 0; }
  ---------------------------------------------------------------- */

  const GRID = 8;
  const CELL = 64;                 // canvas px per cell (416x416 board) — big enough the cat fits comfortably
  const START_SPEED_MS = 260;      // starting tick interval
  const MIN_SPEED_MS = 130;        // fastest it's allowed to get
  const SPEED_STEP_MS = 6;         // gets a little faster per salmon eaten
  const COUNTDOWN_FROM = 3;        // seconds shown before a round actually starts

  let canvas, ctx;
  let snake, dir, pendingDir, salmon, score, salmonThisRound, tickMs;
  let loopHandle, countdownHandle, running;

  function body() { return window.GameModal.body(); }

  /* ---------- lifecycle the page calls ---------- */
  function open() {
    window.GameModal.open('🐈‍⬛ CATnake');
    window.activeGame = api;   // so the page's Exit button can call stop()
    renderHome();
  }
  function stop() {
    clearInterval(loopHandle); loopHandle = null;
    clearInterval(countdownHandle); countdownHandle = null;
    running = false;
    // === MUSIC HOOK === (uncomment once bgMusic exists above)
    // stopMusic();
  }

  /* ---------- screens ---------- */
  function renderHome() {
    stop();
    body().innerHTML = `
      <div class="gscreen">
        <div style="font-size:2.6rem">🐈‍⬛</div>
        <h2>CATnake</h2>
        <p>Guide the cat around the grid to eat salmon. Every salmon makes them
        longer — and every 3rd one banks you a treat for Goose.</p>
        <div class="g-row">
          <button class="g-btn primary" id="playBtn">▶ Play</button>
          <button class="g-btn ghost" id="howBtn">How to play</button>
        </div>
        ${!window.Session.loggedIn ? `<p class="sign-in-note">Sign in on <a href="index.html">the wall</a> to bank the treats you earn.</p>` : ""}
      </div>`;
    body().querySelector('#playBtn').addEventListener('click', beginCountdown);
    body().querySelector('#howBtn').addEventListener('click', renderHowTo);
  }

  function renderHowTo() {
    body().innerHTML = `
      <div class="gscreen">
        <h2>How to play</h2>
        <ul class="how-list">
          <li>Move with the arrow keys / WASD, or the on-screen pad</li>
          <li>Eat salmon 🐟 — the cat's body stretches longer each time</li>
          <li>Each salmon is worth 100 points</li>
          <li>Every 3rd salmon banks you 1 treat to feed Goose</li>
          <li>Don't run into the walls or your own tail!</li>
        </ul>
        <button class="g-btn ghost" id="backBtn">← Back</button>
      </div>`;
    body().querySelector('#backBtn').addEventListener('click', renderHome);
  }

  function beginCountdown() {
    let n = COUNTDOWN_FROM;
    body().innerHTML = `
      <div class="gscreen">
        <div class="countdown" id="cdNum">${n}</div>
      </div>`;
    const numEl = () => document.getElementById('cdNum');

    countdownHandle = setInterval(() => {
      n--;
      if (n > 0) {
        numEl().textContent = n;
      } else if (n === 0) {
        numEl().textContent = 'GO!';
      } else {
        clearInterval(countdownHandle);
        countdownHandle = null;
        startGame();
      }
    }, 1000);
  }

  /* ---------- the actual game ---------- */
  function startGame() {
    snake = [{ x: 4, y: 4 }, { x: 3, y: 4 }, { x: 2, y: 4 }];
    dir = { x: 1, y: 0 };
    pendingDir = dir;
    score = 0;
    salmonThisRound = 0;
    tickMs = START_SPEED_MS;
    running = true;
    placeSalmon();

    body().innerHTML = `
      <div class="hud">
        <span>Score: <b id="scoreVal">0</b></span>
        <span class="fish-badge" id="progressVal">🐟 0/3</span>
      </div>
      <canvas id="catnakeCanvas" width="${GRID * CELL}" height="${GRID * CELL}"></canvas>
      <div class="dpad">
        <button class="up">▲</button>
        <button class="left">◀</button>
        <button class="right">▶</button>
        <button class="down">▼</button>
      </div>`;

    canvas = document.getElementById('catnakeCanvas');
    ctx = canvas.getContext('2d');

    body().querySelector('.up').addEventListener('click', () => turn(0, -1));
    body().querySelector('.down').addEventListener('click', () => turn(0, 1));
    body().querySelector('.left').addEventListener('click', () => turn(-1, 0));
    body().querySelector('.right').addEventListener('click', () => turn(1, 0));

    // === MUSIC HOOK === (uncomment once bgMusic exists above)
    // playMusic();

    draw();
    runLoop();
  }

  function runLoop() {
    clearInterval(loopHandle);
    loopHandle = setInterval(tick, tickMs);
  }

  function turn(x, y) {
    if (!running) return;
    // no reversing straight into your own neck
    if (snake.length > 1 && x === -dir.x && y === -dir.y) return;
    pendingDir = { x, y };
  }

  function onKeydown(e) {
    if (!running) return;
    const map = {
      ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
      ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
      ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
      ArrowRight: [1, 0], d: [1, 0], D: [1, 0]
    };
    if (map[e.key]) {
      e.preventDefault();
      turn(map[e.key][0], map[e.key][1]);
    }
  }
  document.addEventListener('keydown', onKeydown);

  function placeSalmon() {
    const free = [];
    for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) {
      if (!snake.some(s => s.x === x && s.y === y)) free.push({ x, y });
    }
    salmon = free[Math.floor(Math.random() * free.length)];
  }

  function tick() {
    dir = pendingDir;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

    if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID) return gameOver();
    if (snake.some(s => s.x === head.x && s.y === head.y)) return gameOver();

    snake.unshift(head);

    if (head.x === salmon.x && head.y === salmon.y) {
      score += 100;
      salmonThisRound++;
      document.getElementById('scoreVal').textContent = score;
      reportSalmonEaten();
      placeSalmon();
      tickMs = Math.max(MIN_SPEED_MS, tickMs - SPEED_STEP_MS);
      runLoop();   // restart at the new (slightly faster) speed
    } else {
      snake.pop();  // no growth this tick — move forward normally
    }

    draw();
  }

  async function reportSalmonEaten() {
    const progress = document.getElementById('progressVal');
    if (!window.Session.loggedIn) {
      if (progress) progress.textContent = `🐟 ${salmonThisRound % 3}/3 (sign in to bank)`;
      return;
    }
    try {
      const r = await fetch('/api/games/catnake/eat', { method: 'POST' });
      const d = await r.json();
      if (d.status === 'Success') {
        window.Session.tokens = d.tokens;
        const badge = document.getElementById('tokenCount');
        if (badge) badge.textContent = d.tokens;
        if (progress) progress.textContent = `🐟 ${d.salmonEaten % 3}/3` + (d.earnedTreat ? ' 🎉 +1 treat!' : '');
      }
    } catch (e) { /* network hiccup — the round keeps going regardless */ }
  }

  /* ---------- rendering ---------- */
  // proportions tuned at CELL=40 originally, expressed as fractions so the
  // cat still looks right if CELL is ever changed again
  const f = frac => frac * CELL;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.font = `${CELL * 0.7}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🐟', salmon.x * CELL + CELL / 2, salmon.y * CELL + CELL / 2 + f(0.05));

    snake.forEach((seg, i) => {
      const isHead = i === 0;
      const pad = isHead ? f(0.075) : f(0.1) + Math.min(i, 4) * f(0.025);
      ctx.fillStyle = isHead ? '#1d1a22' : '#141019';
      roundRect(ctx, seg.x * CELL + pad, seg.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, f(0.2));
      ctx.fill();

      if (isHead) {
        const cx = seg.x * CELL, cy = seg.y * CELL;
        ctx.fillStyle = '#141019';
        ctx.beginPath();
        ctx.moveTo(cx + f(0.15), cy + f(0.2));
        ctx.lineTo(cx + f(0.35), cy - f(0.05));
        ctx.lineTo(cx + f(0.45), cy + f(0.25));
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + CELL - f(0.15), cy + f(0.2));
        ctx.lineTo(cx + CELL - f(0.35), cy - f(0.05));
        ctx.lineTo(cx + CELL - f(0.45), cy + f(0.25));
        ctx.fill();

        ctx.fillStyle = '#ffc84a';
        const ex = cx + CELL / 2 + dir.x * f(0.1), ey = cy + CELL / 2 + dir.y * f(0.1);
        ctx.beginPath(); ctx.arc(ex - f(0.15), ey, f(0.06), 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(ex + f(0.15), ey, f(0.06), 0, 7); ctx.fill();
      }
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function gameOver() {
    running = false;
    clearInterval(loopHandle); loopHandle = null;
    // === MUSIC HOOK === (uncomment once bgMusic exists above)
    // stopMusic();

    body().innerHTML = `
      <div class="gscreen">
        <div style="font-size:2.2rem">💀🐟</div>
        <h2>Game over!</h2>
        <p>Score: <b style="color:var(--text)">${score}</b></p>
        ${window.Session.loggedIn
          ? `<p>🐟 Tokens now: <b style="color:var(--text)">${window.Session.tokens}</b></p>`
          : `<p class="sign-in-note">Sign in on <a href="index.html">the wall</a> to bank treats next time.</p>`}
        <div class="g-row">
          <button class="g-btn primary" id="againBtn">Play again</button>
          <button class="g-btn ghost" id="homeBtn2">Home</button>
        </div>
      </div>`;
    body().querySelector('#againBtn').addEventListener('click', beginCountdown);
    body().querySelector('#homeBtn2').addEventListener('click', renderHome);
  }

  const api = { open, stop };
  return api;
})();