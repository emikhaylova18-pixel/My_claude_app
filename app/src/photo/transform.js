// Геометрия кадра: поворот на 90°, отражение, выравнивание наклона и обрезка.
// Матрицы записаны как в canvas: [a, b, c, d, e, f] → x' = a·x + c·y + e, y' = b·x + d·y + f.

export const FULL = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
export const DEFAULT_GEOM = Object.freeze({ rot: 0, flip: false, angle: 0, crop: FULL, aspect: 'free' });

export const ASPECTS = [
  { id: 'free', name: 'Свободно', ratio: 0 },
  { id: 'orig', name: 'Исходный', ratio: -1 },
  { id: '1:1', name: '1:1', ratio: 1 },
  { id: '4:5', name: '4:5', ratio: 4 / 5 },
  { id: '3:4', name: '3:4', ratio: 3 / 4 },
  { id: '9:16', name: '9:16', ratio: 9 / 16 },
  { id: '16:9', name: '16:9', ratio: 16 / 9 },
  { id: '3:2', name: '3:2', ratio: 3 / 2 },
];

export const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
export const translateM = (x, y) => [1, 0, 0, 1, x, y];
export const scaleM = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export const rotateM = (rad) => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
};
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export const applyM = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Во сколько раз матрица увеличивает длины (для поворотов и отражений — одинаково во все стороны). */
export const scaleOf = (m) => Math.hypot(m[0], m[1]);

/** Размер кадра после поворота на rot градусов (0, 90, 180, 270). */
export const orientedSize = (w, h, rot) => (rot % 180 ? [h, w] : [w, h]);

/** Во сколько раз увеличить фото при наклоне, чтобы в углах не было пустоты. */
export function coverScale(w, h, deg) {
  const a = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
}

/**
 * Матрица из пикселей исходного фото в пиксели результата.
 * Порядок: поворот на 90° → отражение → наклон (с увеличением) → обрезка → масштаб вывода k.
 * useCrop = false — показать весь кадр (нужно в режиме обрезки).
 */
export function frameMatrix(srcW, srcH, geom, k = 1, useCrop = true) {
  const [fw, fh] = orientedSize(srcW, srcH, geom.rot);
  const crop = useCrop ? geom.crop : FULL;
  let m = scaleM(k);
  m = mul(m, translateM(-crop.x * fw, -crop.y * fh));
  m = mul(m, translateM(fw / 2, fh / 2));
  if (geom.angle) {
    m = mul(m, rotateM((geom.angle * Math.PI) / 180));
    m = mul(m, scaleM(coverScale(fw, fh, geom.angle)));
  }
  if (geom.flip) m = mul(m, scaleM(-1, 1));
  if (geom.rot) m = mul(m, rotateM((geom.rot * Math.PI) / 180));
  return mul(m, translateM(-srcW / 2, -srcH / 2));
}

/** Размер результата (в пикселях исходника) — ширина и высота обрезанного кадра. */
export function outputSize(srcW, srcH, geom, useCrop = true) {
  const [fw, fh] = orientedSize(srcW, srcH, geom.rot);
  const c = useCrop ? geom.crop : FULL;
  return [c.w * fw, c.h * fh];
}

/** Обрезка после поворота кадра на 90° по часовой. */
export const rotateCrop = (c) => ({ x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w });
/** Обрезка после отражения кадра слева направо. */
export const flipCrop = (c) => ({ x: 1 - c.x - c.w, y: c.y, w: c.w, h: c.h });

/** Повернуть весь видимый кадр на 90° по часовой. */
export function rotateGeom(g) {
  return { ...g, rot: (g.rot + (g.flip ? 270 : 90)) % 360, crop: rotateCrop(g.crop), aspect: flipAspect(g.aspect) };
}
/** Отразить видимый кадр слева направо. Наклон при этом меняет знак. */
export function flipGeom(g) {
  return { ...g, flip: !g.flip, angle: -g.angle || 0, crop: flipCrop(g.crop) };
}

function flipAspect(id) {
  if (!id || id === 'free' || id === 'orig' || id === '1:1') return id;
  const [a, b] = id.split(':');
  const back = `${b}:${a}`;
  return ASPECTS.some((x) => x.id === back) ? back : 'free';
}

/** Числовое соотношение сторон для пресета (0 — свободно). */
export function aspectRatio(id, srcW, srcH, rot) {
  const a = ASPECTS.find((x) => x.id === id);
  if (!a || a.ratio === 0) return 0;
  if (a.ratio === -1) {
    const [fw, fh] = orientedSize(srcW, srcH, rot);
    return fw / fh;
  }
  return a.ratio;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Самая большая рамка нужного соотношения внутри кадра fw×fh с центром как у текущей обрезки. */
export function fitAspect(crop, ratio, fw, fh) {
  if (!ratio) return { ...crop };
  let w = Math.min(fw, fh * ratio);
  let h = w / ratio;
  const cx = (crop.x + crop.w / 2) * fw;
  const cy = (crop.y + crop.h / 2) * fh;
  const x = clamp(cx - w / 2, 0, fw - w);
  const y = clamp(cy - h / 2, 0, fh - h);
  return { x: x / fw, y: y / fh, w: w / fw, h: h / fh };
}

/**
 * Перетаскивание рамки обрезки.
 * handle: 'move' или сторона/угол ('n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw');
 * dx, dy — сдвиг в пикселях кадра; ratio — зафиксированное соотношение (0 — свободно).
 */
export function dragCrop(start, handle, dx, dy, fw, fh, ratio = 0, minPx = 24) {
  let x0 = start.x * fw;
  let y0 = start.y * fh;
  let x1 = x0 + start.w * fw;
  let y1 = y0 + start.h * fh;
  const norm = () => ({ x: x0 / fw, y: y0 / fh, w: (x1 - x0) / fw, h: (y1 - y0) / fh });
  minPx = Math.min(minPx, fw / 2, fh / 2);
  if (handle === 'move') {
    const w = x1 - x0;
    const h = y1 - y0;
    x0 = clamp(x0 + dx, 0, fw - w);
    y0 = clamp(y0 + dy, 0, fh - h);
    x1 = x0 + w;
    y1 = y0 + h;
    return norm();
  }
  if (ratio && handle.length === 2) {
    // Угол с фиксированным соотношением: противоположный угол стоит на месте.
    const east = handle.includes('e');
    const south = handle.includes('s');
    const ax = east ? x0 : x1;
    const ay = south ? y0 : y1;
    const px = (east ? x1 : x0) + dx;
    const py = (south ? y1 : y0) + dy;
    let w = Math.max(east ? px - ax : ax - px, (south ? py - ay : ay - py) * ratio);
    const maxW = Math.min(east ? fw - ax : ax, (south ? fh - ay : ay) * ratio);
    w = Math.min(maxW, Math.max(minPx, minPx * ratio, w));
    const h = w / ratio;
    x0 = east ? ax : ax - w;
    x1 = x0 + w;
    y0 = south ? ay : ay - h;
    y1 = y0 + h;
    return norm();
  }
  if (ratio) return { ...start }; // стороны при фиксированном соотношении не тянутся
  if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - minPx);
  if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + minPx, fw);
  if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - minPx);
  if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + minPx, fh);
  return norm();
}
