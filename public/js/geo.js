// Geometria simples em metros sobre WGS84 (suficiente para escala urbana)
const R = 6371008.8;
const RAD = Math.PI / 180;

export function dist(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLng = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLength(coords) {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += dist(coords[i - 1], coords[i]);
  return t;
}

// desloca um ponto dx (leste) / dy (norte) metros
export function offset(p, dx, dy) {
  return [p[0] + (dx / (R * Math.cos(p[1] * RAD))) / RAD, p[1] + (dy / R) / RAD];
}

export function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

// vetor a->b em metros
export function vec(a, b) {
  return [(b[0] - a[0]) * RAD * R * Math.cos(((a[1] + b[1]) / 2) * RAD), (b[1] - a[1]) * RAD * R];
}

export function rect(p, w, d, rotDeg = 0) {
  const c = Math.cos(rotDeg * RAD), s = Math.sin(rotDeg * RAD);
  const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([x, y]) => offset(p, x * c - y * s, x * s + y * c));
  pts.push(pts[0]);
  return [pts];
}

export function circle(p, r, n = 10) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(offset(p, Math.cos(a) * r, Math.sin(a) * r));
  }
  return [pts];
}

// faixa (quadrilátero) de largura w entre a e b
export function band(a, b, w) {
  const [vx, vy] = vec(a, b);
  const L = Math.hypot(vx, vy) || 1;
  const nx = (-vy / L) * (w / 2), ny = (vx / L) * (w / 2);
  return [[offset(a, nx, ny), offset(b, nx, ny), offset(b, -nx, -ny), offset(a, -nx, -ny), offset(a, nx, ny)]];
}

export function bboxOf(coordsList) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coordsList) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return isFinite(w) ? [[w, s], [e, n]] : null;
}

export function fmtM(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2).replace('.', ',')} km` : `${Math.round(m)} m`;
}
