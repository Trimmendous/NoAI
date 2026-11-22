// Falling green characters behind the app in the Matrix theme. Each column's
// head glides down at its own steady speed (time-based, so it stays smooth at
// any frame rate) and leaves a fading trail of glyphs that flicker as they go.
// It only runs while that theme is on and the window is visible; with reduced
// motion it draws one still frame instead.

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:=+*<>¦|';
const SIZE = 18;

const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
const between = (low, high) => low + Math.random() * (high - low);

function column(height, scattered) {
  const length = Math.round(between(8, 30));
  return {
    // Spread the first columns over the screen so it isn't empty at the start.
    y: scattered ? between(-height * .5, height * 1.2) : between(-height * .6, -SIZE * 2),
    speed: between(70, 230), // pixels per second
    length,
    glyphs: Array.from({ length }, glyph),
    bright: Math.random() < .18,
  };
}

export function initMatrixRain(canvas) {
  if (!canvas?.getContext) return;
  const context = canvas.getContext('2d', { alpha: false });
  const root = document.documentElement;
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let columns = [], frame = 0, last = 0, width = 0, height = 0;

  const active = () => root.dataset.skin === 'matrix';
  // The app's own Reduce motion setting counts as much as the system's.
  const reduced = () => !!still?.matches || root.dataset.motion === 'reduce';

  function resize() {
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    width = innerWidth; height = innerHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.ceil(width / SIZE);
    columns = Array.from({ length: count }, (_, index) => columns[index] || column(height, true));
  }

  function draw(seconds) {
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.font = `${SIZE - 3}px ui-monospace, 'SF Mono', Menlo, monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    columns.forEach((item, index) => {
      item.y += item.speed * seconds;
      if (item.y - item.length * SIZE > height) Object.assign(item, column(height, false));
      // A few glyphs change each frame, so the trail shimmers.
      if (Math.random() < seconds * 12) item.glyphs[Math.floor(Math.random() * item.length)] = glyph();
      const x = index * SIZE + SIZE / 2;
      for (let step = item.length - 1; step >= 0; step -= 1) {
        const y = item.y - step * SIZE;
        if (y < -SIZE || y > height) continue;
        const fade = 1 - step / item.length;
        context.fillStyle = step === 0
          ? '#e6ffee'
          : `rgba(${item.bright ? '90, 255, 150' : '0, 230, 92'}, ${(fade * fade * .95).toFixed(3)})`;
        context.fillText(item.glyphs[step], x, y);
      }
    });
  }

  function loop(time) {
    frame = 0;
    if (!active() || document.hidden) return;
    // Clamp long gaps (a background tab, a slow frame) so nothing jumps.
    const seconds = last ? Math.min(.05, (time - last) / 1000) : 1 / 60;
    last = time;
    draw(seconds);
    frame = requestAnimationFrame(loop);
  }

  function start() {
    if (!active()) return;
    if (reduced()) { draw(0); return; }
    if (frame || document.hidden) return;
    last = 0;
    frame = requestAnimationFrame(loop);
  }

  function sync() {
    cancelAnimationFrame(frame); frame = 0;
    canvas.hidden = !active();
    if (!active()) return;
    resize();
    start();
  }

  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-skin', 'data-motion'] });
  document.addEventListener('visibilitychange', start);
  addEventListener('resize', () => { if (active()) { resize(); if (reduced()) draw(0); } });
  still?.addEventListener?.('change', sync);
  sync();
}
