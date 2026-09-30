// Векторизация: превращает картинку (массив RGBA) в набор цветных фигур.
// Шаги: подбор палитры (k-средних) → сглаживание шума → связные области →
// слияние мелочи с соседями → обход границы → упрощение контура.
// Модуль не зависит от браузера и проверяется тестами в Node.

import { polygonArea, removeCollinear, simplifyClosed } from './geometry.js';

/** Предсказуемый генератор случайных чисел, чтобы результат не «прыгал» от запуска к запуску. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const dist2 = (r, g, b, c) => (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;

/**
 * Подбирает k цветов палитры и относит к ним каждый пиксель.
 * Прозрачные пиксели получают метку -1.
 */
export function quantize(img, k, { iterations = 10, samples = 24000, seed = 7 } = {}) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const rand = rng(seed);
  const pts = [];
  const step = Math.max(1, Math.floor(n / samples));
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    pts.push([data[o], data[o + 1], data[o + 2]]);
  }
  const labels = new Int16Array(n).fill(-1);
  if (!pts.length) return { palette: [], labels };

  // k-means++: первый центр случайный, следующие — подальше от уже выбранных.
  const centers = [pts[Math.floor(rand() * pts.length)].slice()];
  const d = new Float64Array(pts.length).fill(Infinity);
  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const v = dist2(pts[i][0], pts[i][1], pts[i][2], c);
      if (v < d[i]) d[i] = v;
      sum += d[i];
    }
    if (sum === 0) break; // цветов в картинке меньше, чем просили
    let r = rand() * sum;
    let pick = pts.length - 1;
    for (let i = 0; i < pts.length; i++) { r -= d[i]; if (r <= 0) { pick = i; break; } }
    centers.push(pts[pick].slice());
  }

  const nearest = (r, g, b) => {
    let best = 0, bd = Infinity;
    for (let j = 0; j < centers.length; j++) {
      const v = dist2(r, g, b, centers[j]);
      if (v < bd) { bd = v; best = j; }
    }
    return best;
  };

  for (let it = 0; it < iterations; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      const a = acc[nearest(p[0], p[1], p[2])];
      a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++;
    }
    let moved = 0;
    for (let j = 0; j < centers.length; j++) {
      const a = acc[j];
      if (!a[3]) continue;
      const nc = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
      moved += dist2(nc[0], nc[1], nc[2], centers[j]);
      centers[j] = nc;
    }
    if (moved < 1) break;
  }

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    labels[i] = nearest(data[o], data[o + 1], data[o + 2]);
  }
  const palette = centers.map((c) => c.map((v) => Math.round(v)));
  return { palette, labels };
}

/** Фильтр большинства 3×3: убирает одиночные «шумные» пиксели. */
export function modeFilter(labels, w, h, k) {
  const out = new Int16Array(labels.length);
  const count = new Int32Array(k + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const own = labels[i];
      count.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          count[labels[yy * w + xx] + 1]++;
        }
      }
      let best = own, bc = count[own + 1];
      for (let j = 0; j <= k; j++) if (count[j] > bc) { bc = count[j]; best = j - 1; }
      // Меняем только почти одинокие пиксели: углы и тонкие линии фигур не трогаем.
      out[i] = count[own + 1] <= 2 && bc >= 5 ? best : own;
    }
  }
  return out;
}

/** Связные области (соседство по сторонам). Возвращает номер области для каждого пикселя. */
export function components(labels, w, h) {
  const comp = new Int32Array(w * h).fill(-1);
  const info = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (comp[start] !== -1 || labels[start] < 0) continue;
    const id = info.length;
    const lab = labels[start];
    let sp = 0, area = 0;
    stack[sp++] = start;
    comp[start] = id;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % w, y = (i - x) / w;
      if (x > 0 && comp[i - 1] === -1 && labels[i - 1] === lab) { comp[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && comp[i + 1] === -1 && labels[i + 1] === lab) { comp[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && comp[i - w] === -1 && labels[i - w] === lab) { comp[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && comp[i + w] === -1 && labels[i + w] === lab) { comp[i + w] = id; stack[sp++] = i + w; }
    }
    info.push({ label: lab, area });
  }
  return { comp, info };
}

/** Мелкие области перекрашиваются в цвет самого частого соседа. */
export function mergeSmall(labels, w, h, minArea, passes = 3) {
  let cur = labels;
  for (let pass = 0; pass < passes; pass++) {
    const { comp, info } = components(cur, w, h);
    const small = info.map((c) => c.area < minArea);
    if (!small.some(Boolean)) return cur;
    const votes = info.map(() => new Map());
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = comp[i];
        if (c < 0 || !small[c]) continue;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) {
          if (j < 0) continue;
          const cj = comp[j];
          if (cj === c || cj < 0) continue;
          const lab = cur[j];
          const weight = small[cj] ? 1 : 4; // крупные соседи важнее
          votes[c].set(lab, (votes[c].get(lab) || 0) + weight);
        }
      }
    }
    const target = votes.map((m) => {
      let best = -2, bv = -1;
      for (const [lab, v] of m) if (v > bv) { bv = v; best = lab; }
      return best;
    });
    const next = new Int16Array(cur);
    let changed = 0;
    for (let i = 0; i < next.length; i++) {
      const c = comp[i];
      if (c >= 0 && small[c] && target[c] !== -2) { next[i] = target[c]; changed++; }
    }
    cur = next;
    if (!changed) break;
  }
  return cur;
}

/**
 * Обходит границы одной области по сторонам пикселей.
 * Внешний контур идёт по часовой стрелке (ось y вниз), дыры — против.
 */
export function traceLoops(comp, w, h, id, box) {
  const W = w + 1;
  const out = new Map(); // вершина → список следующих вершин
  const add = (ax, ay, bx, by) => {
    const a = ay * W + ax;
    const list = out.get(a);
    if (list) list.push(by * W + bx); else out.set(a, [by * W + bx]);
  };
  const x0 = box ? box.x0 : 0, x1 = box ? box.x1 : w - 1, y0 = box ? box.y0 : 0, y1 = box ? box.y1 : h - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (comp[i] !== id) continue;
      if (y === 0 || comp[i - w] !== id) add(x, y, x + 1, y);
      if (x === w - 1 || comp[i + 1] !== id) add(x + 1, y, x + 1, y + 1);
      if (y === h - 1 || comp[i + w] !== id) add(x + 1, y + 1, x, y + 1);
      if (x === 0 || comp[i - 1] !== id) add(x, y + 1, x, y);
    }
  }
  const loops = [];
  const dirOf = (a, b) => [(b % W) - (a % W), Math.floor(b / W) - Math.floor(a / W)];
  for (const [startV, list] of out) {
    while (list.length) {
      const loop = [];
      let prev = startV;
      let v = list.pop();
      loop.push([prev % W, Math.floor(prev / W)]);
      let guard = 0;
      while (v !== startV && guard++ < 4 * (w + 1) * (h + 1)) {
        loop.push([v % W, Math.floor(v / W)]);
        const nexts = out.get(v);
        if (!nexts || !nexts.length) break;
        let pickIdx = 0;
        if (nexts.length > 1) {
          // В точке касания выбираем самый правый поворот, чтобы контур не пересекал сам себя.
          const [dx, dy] = dirOf(prev, v);
          let bestScore = Infinity;
          nexts.forEach((nv, idx) => {
            const [ex, ey] = dirOf(v, nv);
            const cross = dx * ey - dy * ex; // >0 — поворот направо при оси y вниз
            const dot = dx * ex + dy * ey;
            const score = cross > 0 ? 0 : dot > 0 ? 1 : 2;
            if (score < bestScore) { bestScore = score; pickIdx = idx; }
          });
        }
        prev = v;
        v = nexts.splice(pickIdx, 1)[0];
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Главная функция: картинка → фигуры.
 * Каждая фигура — внешний контур одной области; фигуры идут от крупных к мелким,
 * поэтому мелкие лежат сверху и закрывают «дыры» крупных без щелей.
 */
export function traceImage(img, opts = {}) {
  const { colors = 8, tolerance = 1.1, minArea = 16, denoise = true, maxShapes = 2500 } = opts;
  const { width: w, height: h } = img;
  const q = quantize(img, colors, { seed: opts.seed || 7 });
  let labels = denoise ? modeFilter(q.labels, w, h, q.palette.length) : q.labels;
  let min = Math.max(1, minArea);
  let comps;
  for (let attempt = 0; attempt < 5; attempt++) {
    labels = mergeSmall(labels, w, h, min);
    comps = components(labels, w, h);
    if (comps.info.length <= maxShapes) break;
    min *= 2;
  }
  const { comp, info } = comps;

  // Габариты областей, чтобы обходить только нужный прямоугольник.
  const boxes = info.map(() => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = comp[y * w + x];
      if (c < 0) continue;
      const b = boxes[c];
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
    }
  }

  const shapes = [];
  info.forEach((c, id) => {
    const loops = traceLoops(comp, w, h, id, boxes[id]);
    if (!loops.length) return;
    let outer = loops[0], best = -Infinity;
    for (const l of loops) {
      const a = Math.abs(polygonArea(l));
      if (a > best) { best = a; outer = l; }
    }
    let pts = removeCollinear(outer);
    pts = simplifyClosed(pts, tolerance);
    if (pts.length < 3) return;
    const area = Math.abs(polygonArea(pts));
    if (area < 1) return;
    shapes.push({ fill: hex(q.palette[c.label] || [0, 0, 0]), pts, area: c.area });
  });
  shapes.sort((a, b) => b.area - a.area);

  // Цвет фона — самый частый по площади.
  const byColor = new Map();
  for (const s of shapes) byColor.set(s.fill, (byColor.get(s.fill) || 0) + s.area);
  let background = '#ffffff', bgArea = -1;
  for (const [col, a] of byColor) if (a > bgArea) { bgArea = a; background = col; }

  return {
    width: w,
    height: h,
    background,
    palette: q.palette.map(hex),
    shapes: shapes.map((s, i) => ({ id: 's' + (i + 1), fill: s.fill, pts: s.pts })),
  };
}

/** Размер для векторизации: длинная сторона не больше maxSide. */
export function fitSize(w, h, maxSide) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
