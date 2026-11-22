// Shapes for drawing flags as SVG. Coordinates are in the flag's own units.

export const n = value => +value.toFixed(2);
export const rect = (x, y, w, h, fill) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
export const circle = (cx, cy, r, fill) => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}"/>`;
export const poly = (points, fill) => `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${fill}"/>`;
/** Equal (or weighted) horizontal bands. */
export const bandsH = (colors, ratios = colors.map(() => 1), w = 900, h = 600) => {
  const total = ratios.reduce((a, b) => a + b, 0);
  let y = 0;
  return colors.map((color, i) => { const height = h * ratios[i] / total; const out = rect(0, y, w, height + 0.5, color); y += height; return out; }).join('');
};
/** Equal (or weighted) vertical bands. */
export const bandsV = (colors, ratios = colors.map(() => 1), w = 900, h = 600) => {
  const total = ratios.reduce((a, b) => a + b, 0);
  let x = 0;
  return colors.map((color, i) => { const width = w * ratios[i] / total; const out = rect(x, 0, width + 0.5, h, color); x += width; return out; }).join('');
};
/** A star with `points` points; `rotation` 0 points straight up. */
export const star = (cx, cy, r, fill, rotation = 0, points = 5, inner = points === 5 ? 0.382 : 0.5) => {
  const out = [];
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 ? r * inner : r;
    const angle = (rotation - 90 + i * 180 / points) * Math.PI / 180;
    out.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return poly(out, fill);
};
export const towards = (cx, cy, tx, ty) => Math.atan2(ty - cy, tx - cx) * 180 / Math.PI + 90;
/** A crescent: a disc with an offset disc of the background colour cut out. */
export const crescent = (cx, cy, r, dx, dy, cut, fill, background) => circle(cx, cy, r, fill) + circle(cx + dx, cy + dy, cut, background);
/** A triangle from the hoist (left edge) to `depth`. */
export const hoist = (depth, fill, h = 600) => poly([[0, 0], [depth, h / 2], [0, h]], fill);
export const text = (x, y, size, fill, value) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="middle" font-family="Geeza Pro, Arial, sans-serif" direction="rtl">${value}</text>`;
export const unionJack = (x, y, w, h) => `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 60 30" preserveAspectRatio="none"><rect width="60" height="30" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="2"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></svg>`;
/** A Nordic cross with the upright at x..x+width on a w×h flag. */
export const nordic = (x, width, fill, w, h) => rect(x, 0, width, h, fill) + rect(0, (h - width) / 2, w, width, fill);
export const mapleLeaf = (cx, cy, s, fill) => {
  const half = [[0, -10], [1.8, -6.2], [3.6, -7.2], [3, -2.6], [5.6, -4.6], [6.4, -3], [9.4, -3.6], [8.4, -0.6], [9.6, 0.2], [5.2, 3.6], [5.8, 5.4], [0.6, 4.6]];
  const points = [...half, [0.6, 9], [-0.6, 9], ...half.slice(1).reverse().map(([x, y]) => [-x, y])];
  return poly(points.map(([x, y]) => [cx + x * s, cy + y * s]), fill);
};

/** One place. `note` marks a judgement call (disputed status or flag choice) for the README. */
export const c = (code, name, accent, tint, draw, size, note) => ({ code, name, accent, tint, note, flag: { kind: 'custom', draw, size } });


/** A British-style ensign: the Union Jack in the top-left quarter of a `field` flag. */
export const ensign = (field, w = 1200, h = 600) => rect(0, 0, w, h, field) + unionJack(0, 0, w / 2, h / 2);
/** A heater shield with its top-left corner at x,y. */
export const shield = (x, y, w, h, fill, stroke = '') => `<path d="M${n(x)},${n(y)} h${n(w)} v${n(h * 0.55)} q0,${n(h * 0.45)} ${n(-w / 2)},${n(h * 0.45)} q${n(-w / 2)},0 ${n(-w / 2)},${n(-h * 0.45)} z" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${n(w * 0.06)}"` : ''}/>`;
/** A straight band between two points, optionally with a border. */
export const band = (x1, y1, x2, y2, width, fill, border = '', borderWidth = 0) => (border ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${border}" stroke-width="${width + 2 * borderWidth}"/>` : '') + `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${fill}" stroke-width="${width}"/>`;
/** A Nordic cross with a narrower cross of another colour inside it. */
export const nordicBordered = (x, width, inner, outer, innerColor, w, h) => nordic(x, width, outer, w, h) + nordic(x + (width - inner) / 2, inner, innerColor, w, h);
/** A ring of `count` stars. */
export const starRing = (cx, cy, radius, count, size, fill, start = -90) => Array.from({ length: count }, (_, i) => { const a = (start + i * 360 / count) * Math.PI / 180; return star(cx + radius * Math.cos(a), cy + radius * Math.sin(a), size, fill); }).join('');
