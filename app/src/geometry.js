// Геометрия контуров: площадь, упрощение, габариты, построение пути SVG.
// Здесь нет ничего из браузера, поэтому модуль проверяется тестами в Node.

/** Площадь многоугольника со знаком (формула шнурков). */
export function polygonArea(points) {
  let s = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Расстояние от точки p до отрезка ab. */
export function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Алгоритм Дугласа — Пекера для незамкнутой ломаной. */
export function simplifyOpen(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistance(points[i], points[first], points[last]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Упрощение замкнутого контура: делим его на две половины по самой дальней точке. */
export function simplifyClosed(points, tolerance) {
  if (points.length <= 3) return points.slice();
  let far = 0;
  let best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > best) { best = d; far = i; }
  }
  const a = simplifyOpen(points.slice(0, far + 1), tolerance);
  const b = simplifyOpen(points.slice(far).concat([points[0]]), tolerance);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/** Убирает точки, лежащие на одной прямой с соседями. */
export function removeCollinear(points) {
  if (points.length < 4) return points.slice();
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n];
    const c = points[i];
    const q = points[(i + 1) % n];
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    if (cross !== 0) out.push(c);
  }
  return out.length >= 3 ? out : points.slice();
}

/** Габариты набора точек. */
export function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const r1 = (v) => Math.round(v * 10) / 10;

/** Острый ли угол в вершине: направление меняется больше чем на limitDeg градусов. */
export function isCorner(prev, p, next, limitDeg = 55) {
  const ax = p[0] - prev[0], ay = p[1] - prev[1];
  const bx = next[0] - p[0], by = next[1] - p[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (!la || !lb) return false;
  const cos = (ax * bx + ay * by) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI > limitDeg;
}

/**
 * Путь SVG для замкнутого контура.
 * smooth = true — плавные кривые через середины сторон, но острые углы остаются углами;
 * smooth = false — ломаная.
 */
export function pathD(points, smooth) {
  const n = points.length;
  if (n < 2) return '';
  if (!smooth || n < 3) {
    return 'M' + points.map(([x, y]) => r1(x) + ' ' + r1(y)).join('L') + 'Z';
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const P = (q) => r1(q[0]) + ' ' + r1(q[1]);
  const start = mid(points[n - 1], points[0]);
  let d = 'M' + P(start);
  for (let i = 0; i < n; i++) {
    const c = points[i];
    const next = points[(i + 1) % n];
    const m = mid(c, next);
    if (isCorner(points[(i - 1 + n) % n], c, next)) d += 'L' + P(c) + 'L' + P(m);
    else d += 'Q' + P(c) + ' ' + P(m);
  }
  return d + 'Z';
}

/** Попадает ли точка внутрь многоугольника (правило чётности). */
export function pointInPolygon(pt, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Сдвиг всех точек. */
export function translate(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

/** Масштаб точек относительно центра (cx, cy). */
export function scaleAround(points, k, cx, cy) {
  return points.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}
