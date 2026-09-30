// Фоторедактор: интерфейс, жесты и отрисовка.
// Оригинал фото не меняется. Все правки хранятся списком (документ doc),
// а картинка каждый раз собирается заново: ретушь → кадр → коррекция → рисунок → текст.

import { PARAMS, DEFAULTS, applyAdjustments, autoParams, histogram, isIdentity } from './adjust.js';
import { FILTERS, combineParams, filterById } from './filters.js';
import {
  frameMatrix, outputSize, orientedSize, invert, applyM, mul, scaleOf, rotateGeom, flipGeom,
  fitAspect, dragCrop, aspectRatio, ASPECTS, DEFAULT_GEOM, FULL,
} from './transform.js';
import { healSpot } from './heal.js';
import { createHistory } from '../history.js';
import { idbGet, idbSet } from './store.js';

const $ = (id) => document.getElementById(id);
const MAX_SRC = 4096;
const MAX_AREA = 16e6;
const PREV_SIDE = 2048;
const FAST_SIDE = 900;
const THUMB_KEY = 'studio-raster-thumb';
const BRUSH_KEY = 'studio-brush';
const COLORS = ['#1f1a1c', '#ffffff', '#a8456a', '#e8798f', '#f2b8a2', '#ffd35c', '#86c07a', '#6fa8dc', '#8e7cc3', '#e53935'];
const FONTS = {
  sans: { family: "'Manrope', system-ui, sans-serif", weight: 800 },
  serif: { family: "'Cormorant Garamond', Georgia, serif", weight: 700 },
  hand: { family: "'Caveat', 'Segoe Script', cursive", weight: 700 },
};

const newDoc = () => ({
  v: 1,
  adj: { ...DEFAULTS },
  filter: { id: 'none', amount: 100 },
  geom: { ...DEFAULT_GEOM, crop: { ...FULL } },
  spots: [],
  strokes: [],
  texts: [],
  paint: { visible: true, opacity: 1 },
});
const cloneDoc = (d) => ({ ...d, adj: { ...d.adj }, filter: { ...d.filter }, geom: { ...d.geom, crop: { ...d.geom.crop } }, paint: { ...d.paint } });

const S = {
  doc: newDoc(),
  src: null, // { img, w, h }
  prev: null, // уменьшенная копия для экрана (до 2048 px)
  prevScale: 1,
  mode: 'adjust',
  param: 'exposure',
  view: { s: 1, tx: 0, ty: 0 },
  brush: { mode: 'paint', color: '#a8456a', size: 24, soft: 30, opacity: 100 },
  healSize: 28,
  selText: null,
  comparing: false,
};
const history = createHistory(60, cloneDoc);
const ver = { geom: 0, crop: 0, adj: 0, paint: 0, heal: 0 };
const cache = {
  healed: null, healedData: null, healedFor: null,
  photo: null, photoKey: '',
  paint: null, paintKey: '',
  original: null, originalKey: '',
  layout: null,
  histKey: '',
  thumbsKey: '',
};
let textIdSeq = 1;

/* ---------- мелочи ---------- */
const canvas = $('pCanvas');
const wrap = $('pStageWrap');
let dpr = 1;
let cssW = 0;
let cssH = 0;

function sized(c, w, h, opts) {
  if (!c) {
    c = document.createElement('canvas');
    if (opts) c.getContext('2d', opts);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}
const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
});
const toBlob = (c, type, q) => new Promise((resolve) => c.toBlob(resolve, type, q));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('pToast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) {
  $('pBusyText').textContent = text || '';
  $('pBusy').hidden = !text;
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const isDark = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
};

/* ---------- геометрия экрана ---------- */
function sizeCanvas() {
  const r = wrap.getBoundingClientRect();
  dpr = Math.min(3, window.devicePixelRatio || 1);
  cssW = r.width;
  cssH = r.height;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
}
const useCropNow = () => S.mode !== 'crop';
function layoutNow() {
  const useCrop = useCropNow();
  const [cw, ch] = outputSize(S.src.w, S.src.h, S.doc.geom, useCrop);
  return { useCrop, cw, ch };
}
/** Из пикселей исходника в единицы кадра (как на экране при масштабе 1). */
const frameM1 = () => frameMatrix(S.src.w, S.src.h, S.doc.geom, 1, useCropNow());
/** Из пикселей исходника в CSS-пиксели экрана. */
const screenM = () => mul([S.view.s, 0, 0, S.view.s, S.view.tx, S.view.ty], frameM1());
const toSource = (p) => applyM(invert(screenM()), [p.x, p.y]);

function fitView() {
  if (!S.src) return;
  const { cw, ch } = layoutNow();
  const pad = S.mode === 'crop' ? 28 : 14;
  const s = Math.max(0.01, Math.min((cssW - pad * 2) / cw, (cssH - pad * 2) / ch));
  S.view = { s, tx: (cssW - cw * s) / 2, ty: (cssH - ch * s) / 2 };
}

function chooseK(cw, ch, fast) {
  const cap = (fast ? FAST_SIDE : PREV_SIDE) / Math.max(cw, ch);
  let k = Math.min(S.prevScale, S.view.s * dpr, cap);
  k = Math.pow(2, Math.round(Math.log2(k) * 4) / 4); // ступеньками, чтобы не перерисовывать на каждое движение
  return Math.max(0.005, Math.min(k, S.prevScale, cap));
}

/* ---------- слои ---------- */
function ensureHealed() {
  const spots = S.doc.spots;
  if (cache.healedFor === spots && cache.healed) return;
  const prevSpots = cache.healedFor;
  if (!spots.length) {
    cache.healed = S.prev;
    cache.healedData = null;
    cache.healedFor = spots;
    ver.heal++;
    return;
  }
  const ps = S.prevScale;
  let start = 0;
  const incremental = cache.healedData && prevSpots && spots.length > prevSpots.length && prevSpots.every((s, i) => s === spots[i]);
  if (incremental) start = prevSpots.length;
  else {
    const c = sized(null, S.prev.width, S.prev.height, { willReadFrequently: true });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(S.prev, 0, 0);
    cache.healed = c;
    cache.healedData = ctx.getImageData(0, 0, c.width, c.height);
  }
  const ctx = cache.healed.getContext('2d', { willReadFrequently: true });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = start; i < spots.length; i++) {
    const s = spots[i];
    healSpot(cache.healedData, s.x * ps, s.y * ps, s.r * ps);
    const R = s.r * ps * 1.5 + 2;
    x0 = Math.min(x0, s.x * ps - R); y0 = Math.min(y0, s.y * ps - R);
    x1 = Math.max(x1, s.x * ps + R); y1 = Math.max(y1, s.y * ps + R);
  }
  if (incremental) {
    const dx = Math.max(0, Math.floor(x0)), dy = Math.max(0, Math.floor(y0));
    ctx.putImageData(cache.healedData, 0, 0, dx, dy, Math.ceil(x1) - dx, Math.ceil(y1) - dy);
  } else ctx.putImageData(cache.healedData, 0, 0);
  cache.healedFor = spots;
  ver.heal++;
}

const effectiveParams = () => combineParams(S.doc.adj, S.doc.filter.id, S.doc.filter.amount);

/** Рисует фото с кадром в ctx (без коррекции). */
function drawBase(ctx, base, M, ow, oh) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ow, oh);
  ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0, S.src.w, S.src.h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function ensureLayers(fast) {
  const { useCrop, cw, ch } = layoutNow();
  const k = chooseK(cw, ch, fast);
  const ow = Math.max(1, Math.round(cw * k));
  const oh = Math.max(1, Math.round(ch * k));
  const M = frameMatrix(S.src.w, S.src.h, S.doc.geom, k, useCrop);
  ensureHealed();
  const g = useCrop ? `${ver.geom}.${ver.crop}` : `${ver.geom}.full`;
  const photoKey = `${ver.heal}|${g}|${ver.adj}|${k}`;
  if (cache.photoKey !== photoKey) {
    cache.photo = sized(cache.photo, ow, oh, { willReadFrequently: true });
    const ctx = cache.photo.getContext('2d', { willReadFrequently: true });
    drawBase(ctx, cache.healed, M, ow, oh);
    const params = effectiveParams();
    if (!isIdentity(params)) {
      const id = ctx.getImageData(0, 0, ow, oh);
      applyAdjustments(id, params);
      ctx.putImageData(id, 0, 0);
    }
    cache.photoKey = photoKey;
  }
  const paintKey = `${ver.paint}|${g}|${k}`;
  if (cache.paintKey !== paintKey) {
    cache.paint = sized(cache.paint, ow, oh);
    renderStrokes(cache.paint.getContext('2d'), S.doc.strokes, M, ow, oh);
    cache.paintKey = paintKey;
  }
  cache.layout = { useCrop, cw, ch, k, ow, oh, M };
}

function ensureOriginal() {
  const L = cache.layout;
  const key = `${ver.geom}.${L.useCrop ? ver.crop : 'full'}|${L.k}`;
  if (cache.originalKey === key) return;
  cache.original = sized(cache.original, L.ow, L.oh);
  drawBase(cache.original.getContext('2d'), S.prev, L.M, L.ow, L.oh);
  cache.originalKey = key;
}

/* ---------- кисть ---------- */
const tips = new Map();
function brushTip(color, hardness) {
  const key = color + '|' + hardness.toFixed(2);
  let c = tips.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  const [r, gg, b] = hexToRgb(color);
  const h = clamp(hardness, 0, 0.97);
  grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  grad.addColorStop(h, `rgba(${r},${gg},${b},1)`);
  grad.addColorStop(h + (1 - h) * 0.5, `rgba(${r},${gg},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  if (tips.size > 40) tips.clear();
  tips.set(key, c);
  return c;
}
function strokeTip(st) {
  return brushTip(st.mode === 'erase' ? '#000000' : st.color, 1 - st.soft / 100);
}
const spacingOf = (st, M) => Math.max(st.size * (0.1 + 0.15 * (st.soft / 100)), 0.6 / scaleOf(M));

function dab(ctx, tip, p, r) {
  ctx.drawImage(tip, p[0] - r, p[1] - r, r * 2, r * 2);
}
/** Штампует отрезок кисти, возвращает «остаток» пути до следующего мазка. */
function stampSegment(ctx, tip, r, a, b, spacing, carry) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return carry;
  let t = spacing - carry;
  let last = -carry;
  while (t <= len) {
    dab(ctx, tip, [a[0] + (dx * t) / len, a[1] + (dy * t) / len], r);
    last = t;
    t += spacing;
  }
  return len - last;
}
function stampStroke(ctx, st, M) {
  const tip = strokeTip(st);
  const r = st.size / 2;
  const sp = spacingOf(st, M);
  dab(ctx, tip, st.pts[0], r);
  let carry = 0;
  for (let i = 1; i < st.pts.length; i++) carry = stampSegment(ctx, tip, r, st.pts[i - 1], st.pts[i], sp, carry);
}
let strokeTmp = null;
function strokeBox(st, M, ow, oh) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of st.pts) {
    const [x, y] = applyM(M, p);
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const r = (st.size / 2) * scaleOf(M) + 2;
  const bx = clamp(Math.floor(x0 - r), 0, ow);
  const by = clamp(Math.floor(y0 - r), 0, oh);
  return { x: bx, y: by, w: clamp(Math.ceil(x1 + r), 0, ow) - bx, h: clamp(Math.ceil(y1 + r), 0, oh) - by };
}
function compositeStroke(ctx, tmp, st, box) {
  if (box.w <= 0 || box.h <= 0) return;
  ctx.globalAlpha = st.opacity / 100;
  ctx.globalCompositeOperation = st.mode === 'erase' ? 'destination-out' : 'source-over';
  ctx.drawImage(tmp, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
function renderStrokes(ctx, strokes, M, ow, oh) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ow, oh);
  if (!strokes.length) return;
  strokeTmp = sized(strokeTmp, ow, oh);
  const t = strokeTmp.getContext('2d');
  for (const st of strokes) {
    const box = strokeBox(st, M, ow, oh);
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.clearRect(box.x, box.y, box.w, box.h);
    t.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    stampStroke(t, st, M);
    t.setTransform(1, 0, 0, 1, 0, 0);
    compositeStroke(ctx, strokeTmp, st, box);
  }
}

/* ---------- текст ---------- */
const measureCtx = document.createElement('canvas').getContext('2d');
function fontOf(t, px) {
  const f = FONTS[t.font] || FONTS.sans;
  return `${f.weight} ${px}px ${f.family}`;
}
function textExtent(t, px) {
  measureCtx.font = fontOf(t, px);
  const lines = t.text.split('\n');
  const w = Math.max(...lines.map((l) => measureCtx.measureText(l).width), px * 0.5);
  return { lines, w, h: lines.length * px * 1.15 };
}
/** Текст всегда стоит ровно, даже если фото повёрнуто: двигается вместе с фото, но не крутится. */
function drawText(ctx, t, M) {
  const [x, y] = applyM(M, [t.x, t.y]);
  const px = t.size * scaleOf(M);
  if (px < 0.5) return;
  const { lines } = textExtent(t, px);
  const lh = px * 1.15;
  const y0 = y - ((lines.length - 1) * lh) / 2;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = t.opacity ?? 1;
  ctx.font = fontOf(t, px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (t.shadow) {
    ctx.shadowColor = 'rgba(20, 10, 15, 0.45)';
    ctx.shadowBlur = px * 0.14;
    ctx.shadowOffsetY = px * 0.04;
  }
  if (t.outline) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = px * 0.14;
    ctx.strokeStyle = isDark(t.color) ? '#ffffff' : '#2b1d22';
    lines.forEach((l, i) => ctx.strokeText(l, x, y0 + i * lh));
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = t.color;
  lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh));
  ctx.restore();
}
function textBoxScreen(t) {
  const M = screenM();
  const [x, y] = applyM(M, [t.x, t.y]);
  const px = t.size * scaleOf(M);
  const { w, h } = textExtent(t, px);
  return { x: x - w / 2 - 10, y: y - h / 2 - 8, w: w + 20, h: h + 16 };
}
function hitText(p) {
  const list = S.doc.texts;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (t.visible === false) continue;
    const b = textBoxScreen(t);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return t;
  }
  return null;
}
const selectedText = () => S.doc.texts.find((t) => t.id === S.selText) || null;

/* ---------- отрисовка на экран ---------- */
let rafId = 0;
let needLayers = false;
let fastLayers = false;
let settleTimer = 0;
let live = null; // рисуемый сейчас мазок
let livePaint = null;
let healTrail = null; // точки ретуши, пока палец ведёт
let cursor = null; // кружок кисти
let cursorTimer = 0;

function requestRender(fast = false) {
  needLayers = true;
  fastLayers = fast;
  clearTimeout(settleTimer);
  if (fast) settleTimer = setTimeout(() => requestRender(false), 260);
  if (!rafId) rafId = requestAnimationFrame(frame);
}
function redraw() {
  if (!rafId) rafId = requestAnimationFrame(frame);
}
function frame() {
  rafId = 0;
  if (S.src && (needLayers || !cache.layout)) {
    ensureLayers(fastLayers);
    needLayers = false;
    if (S.mode === 'adjust') drawHistogram();
  }
  draw();
}

let bgColor = '#FBF3F0';
function readTheme() {
  bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#FBF3F0';
}

function draw() {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!S.src || !cache.layout) return;
  const L = cache.layout;
  const { s, tx, ty } = S.view;
  const sc = (dpr * s) / L.k;
  ctx.save();
  ctx.setTransform(sc, 0, 0, sc, dpr * tx, dpr * ty);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = sc < 1 ? 'high' : 'medium';
  ctx.shadowColor = 'rgba(58, 42, 47, 0.18)';
  ctx.shadowBlur = 18 * dpr;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, L.ow, L.oh);
  ctx.shadowColor = 'transparent';
  if (S.comparing) {
    ensureOriginal();
    ctx.drawImage(cache.original, 0, 0);
  } else {
    ctx.drawImage(cache.photo, 0, 0);
    if (S.doc.paint.visible) {
      ctx.globalAlpha = S.doc.paint.opacity;
      ctx.drawImage(live && livePaint ? livePaint : cache.paint, 0, 0);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  if (!S.comparing) {
    const Md = mul([dpr, 0, 0, dpr, 0, 0], screenM());
    for (const t of S.doc.texts) if (t.visible !== false) drawText(ctx, t, Md);
  }
  drawOverlay(ctx);
}

function drawOverlay(ctx) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.mode === 'crop') drawCropOverlay(ctx);
  if (S.mode === 'text' && !S.comparing) {
    const t = selectedText();
    if (t) {
      const b = textBoxScreen(t);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = '#D94F7F';
      ctx.lineDashOffset = 5;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
    }
  }
  if (healTrail) {
    for (const p of healTrail.screen) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], p[2], 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.fill();
    }
  }
  if (cursor) {
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, cursor.r, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  ctx.restore();
}

function cropRectScreen() {
  const [fw, fh] = orientedSize(S.src.w, S.src.h, S.doc.geom.rot);
  const c = S.doc.geom.crop;
  const { s, tx, ty } = S.view;
  return { x: tx + c.x * fw * s, y: ty + c.y * fh * s, w: c.w * fw * s, h: c.h * fh * s };
}
function drawCropOverlay(ctx) {
  const r = cropRectScreen();
  const { cw, ch } = layoutNow();
  const { s, tx, ty } = S.view;
  const ix = tx, iy = ty, iw = cw * s, ih = ch * s;
  ctx.fillStyle = 'rgba(28, 16, 22, 0.55)';
  ctx.fillRect(ix, iy, iw, r.y - iy);
  ctx.fillRect(ix, r.y + r.h, iw, iy + ih - r.y - r.h);
  ctx.fillRect(ix, r.y, r.x - ix, r.h);
  ctx.fillRect(r.x + r.w, r.y, ix + iw - r.x - r.w, r.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(r.x + (r.w * i) / 3, r.y); ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
    ctx.moveTo(r.x, r.y + (r.h * i) / 3); ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
    ctx.stroke();
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  const L = Math.min(20, r.w / 3, r.h / 3);
  const corners = [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1]];
  ctx.beginPath();
  for (const [x, y, dx, dy] of corners) {
    ctx.moveTo(x + dx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * L);
  }
  if (!currentRatio()) {
    const mx = r.x + r.w / 2, my = r.y + r.h / 2;
    ctx.moveTo(mx - 10, r.y); ctx.lineTo(mx + 10, r.y);
    ctx.moveTo(mx - 10, r.y + r.h); ctx.lineTo(mx + 10, r.y + r.h);
    ctx.moveTo(r.x, my - 10); ctx.lineTo(r.x, my + 10);
    ctx.moveTo(r.x + r.w, my - 10); ctx.lineTo(r.x + r.w, my + 10);
  }
  ctx.stroke();
}
function hitCrop(p) {
  const r = cropRectScreen();
  const T = 26;
  const nearL = Math.abs(p.x - r.x) < T, nearR = Math.abs(p.x - (r.x + r.w)) < T;
  const nearT = Math.abs(p.y - r.y) < T, nearB = Math.abs(p.y - (r.y + r.h)) < T;
  if (nearT && nearL) return 'nw';
  if (nearT && nearR) return 'ne';
  if (nearB && nearL) return 'sw';
  if (nearB && nearR) return 'se';
  const insideX = p.x > r.x && p.x < r.x + r.w;
  const insideY = p.y > r.y && p.y < r.y + r.h;
  if (!currentRatio()) {
    if (nearT && insideX) return 'n';
    if (nearB && insideX) return 's';
    if (nearL && insideY) return 'w';
    if (nearR && insideY) return 'e';
  }
  if (insideX && insideY) return 'move';
  return null;
}
const currentRatio = () => aspectRatio(S.doc.geom.aspect, S.src.w, S.src.h, S.doc.geom.rot);

function drawHistogram() {
  const hc = $('pHist');
  if (!cache.photo || cache.histKey === cache.photoKey) return;
  cache.histKey = cache.photoKey;
  const ctx = cache.photo.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, cache.photo.width, cache.photo.height);
  const h = histogram(img, Math.max(1, Math.floor((img.width * img.height) / 40000)));
  const g = hc.getContext('2d');
  const W = hc.width, H = hc.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(28, 16, 22, 0.45)';
  g.beginPath();
  g.roundRect ? g.roundRect(0, 0, W, H, 10) : g.rect(0, 0, W, H);
  g.fill();
  const draw1 = (arr, color) => {
    let max = 1;
    for (let i = 2; i < 254; i++) if (arr[i] > max) max = arr[i];
    g.beginPath();
    g.moveTo(6, H - 5);
    for (let i = 0; i < 256; i++) g.lineTo(6 + (i / 255) * (W - 12), H - 5 - Math.min(1, arr[i] / max) * (H - 12));
    g.lineTo(W - 6, H - 5);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  };
  g.globalCompositeOperation = 'lighter';
  draw1(h.r, 'rgba(230, 90, 110, 0.55)');
  draw1(h.g, 'rgba(110, 200, 130, 0.5)');
  draw1(h.b, 'rgba(110, 150, 240, 0.55)');
  g.globalCompositeOperation = 'source-over';
}

/* ---------- изменения ---------- */
function commit(fn, parts = []) {
  history.push(S.doc);
  fn(S.doc);
  touch(...parts);
}
function touch(...parts) {
  for (const p of parts) ver[p]++;
  requestRender(false);
  updateUI();
  saveSoon();
}
let session = false;
function beginSession() {
  if (!session) {
    history.push(S.doc);
    session = true;
  }
}
function endSession() {
  if (session) {
    session = false;
    updateUI();
    saveSoon();
  }
}

function afterDocSwap(refit) {
  for (const k of Object.keys(ver)) ver[k]++;
  cache.healedFor = null;
  cache.healedData = null;
  if (!selectedText()) S.selText = null;
  if (refit) fitView();
  requestRender(false);
  updateUI();
  syncControls();
  saveSoon();
}
const dimsKey = () => (S.src ? layoutNow().cw.toFixed(2) + 'x' + layoutNow().ch.toFixed(2) : '');
function swapDoc(next) {
  const before = dimsKey();
  S.doc = next;
  afterDocSwap(before !== dimsKey());
}
function undo() {
  const prev = history.undo(S.doc);
  if (prev) swapDoc(prev);
}
function redo() {
  const next = history.redo(S.doc);
  if (next) swapDoc(next);
}

/* ---------- панели ---------- */
function buildAdjChips() {
  let html = '<button class="chip auto" type="button" data-auto="1">✦ Авто</button>';
  let group = '';
  for (const p of PARAMS) {
    if (p.group !== group) {
      group = p.group;
      html += `<span class="chip-sep" aria-hidden="true">${group}</span>`;
    }
    html += `<button class="chip" type="button" data-param="${p.key}" aria-pressed="false">${p.label}<i class="dot" aria-hidden="true"></i></button>`;
  }
  $('adjChips').innerHTML = html;
}
function selectParam(key) {
  S.param = key;
  const p = PARAMS.find((x) => x.key === key);
  const r = $('adjRange');
  r.min = p.min;
  r.max = p.max;
  r.value = S.doc.adj[key] || 0;
  $('adjName').textContent = p.label;
  showAdjVal();
  document.querySelectorAll('#adjChips [data-param]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.param === key)));
}
function showAdjVal() {
  const v = Math.round(S.doc.adj[S.param] || 0);
  $('adjVal').textContent = v > 0 ? '+' + v : String(v);
  $('adjReset').disabled = !v;
}

function buildAspectChips() {
  $('aspectChips').innerHTML = ASPECTS.map((a) => `<button class="chip" type="button" data-aspect="${a.id}" aria-pressed="false">${a.name}</button>`).join('');
}

function buildSwatches(el, cls) {
  el.innerHTML = COLORS.map((c) => `<button type="button" class="sw ${cls}" data-color="${c}" style="background:${c}" aria-label="Цвет ${c}" aria-pressed="false"></button>`).join('');
}

/** Маленькая картинка текущего кадра без коррекции (для «Авто» и превью фильтров). */
function renderSmall(maxSide) {
  ensureHealed();
  const [cw, ch] = outputSize(S.src.w, S.src.h, S.doc.geom, true);
  const k = Math.min(S.prevScale, maxSide / Math.max(cw, ch));
  const ow = Math.max(1, Math.round(cw * k));
  const oh = Math.max(1, Math.round(ch * k));
  const c = sized(null, ow, oh, { willReadFrequently: true });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  drawBase(ctx, cache.healed, frameMatrix(S.src.w, S.src.h, S.doc.geom, k, true), ow, oh);
  return ctx.getImageData(0, 0, ow, oh);
}

function buildFilterThumbs() {
  const key = `${ver.heal}|${ver.geom}.${ver.crop}|${ver.adj}`;
  const box = $('filterThumbs');
  if (cache.thumbsKey !== key) {
    cache.thumbsKey = key;
    const base = renderSmall(160);
    const side = Math.min(base.width, base.height);
    const ox = Math.floor((base.width - side) / 2);
    const oy = Math.floor((base.height - side) / 2);
    box.innerHTML = '';
    for (const f of FILTERS) {
      const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
      applyAdjustments(img, combineParams(S.doc.adj, f.id, 100), { clarityRadius: 3 });
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const tmp = sized(null, base.width, base.height);
      tmp.getContext('2d').putImageData(img, 0, 0);
      c.getContext('2d').drawImage(tmp, ox, oy, side, side, 0, 0, 128, 128);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'thumb';
      b.dataset.filter = f.id;
      b.setAttribute('aria-pressed', 'false');
      b.append(c);
      const span = document.createElement('span');
      span.textContent = f.name;
      b.append(span);
      box.append(b);
    }
  }
  box.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === S.doc.filter.id)));
}

function setMode(m) {
  if (!S.src) return;
  const wasCrop = S.mode === 'crop';
  S.mode = m;
  if (m !== 'text') S.selText = null;
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== m; });
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('pHist').hidden = m !== 'adjust';
  if (m === 'adjust') cache.histKey = '';
  if (m === 'filters') buildFilterThumbs();
  if (wasCrop !== (m === 'crop')) fitView();
  if (m === 'crop' && !wasCrop) toast('Потяни за углы рамки. Двумя пальцами — приблизить.');
  if (m === 'heal' && !S.doc.spots.length) toast('Коснись пятнышка, и оно исчезнет.');
  requestRender(false);
  updateUI();
}

function syncControls() {
  if (!S.src) return;
  selectParam(S.param);
  $('filterRange').value = S.doc.filter.amount;
  $('filterVal').textContent = S.doc.filter.amount;
  $('angleRange').value = S.doc.geom.angle;
  $('angleVal').textContent = formatAngle(S.doc.geom.angle);
}
const formatAngle = (a) => (a > 0 ? '+' : '') + (Math.round(a * 10) / 10).toString().replace('.', ',') + '°';

function updateUI() {
  const has = !!S.src;
  $('pWelcome').hidden = has;
  $('pPanel').hidden = !has;
  $('pFit').hidden = !has;
  document.querySelectorAll('[data-mode]').forEach((b) => { b.disabled = !has; });
  $('pUndo').disabled = !history.canUndo();
  $('pRedo').disabled = !history.canRedo();
  $('pExport').disabled = !has;
  $('pLayers').disabled = !has;
  $('pCompare').disabled = !has;
  if (!has) return;
  document.querySelectorAll('#adjChips [data-param]').forEach((b) => b.classList.toggle('on', !!S.doc.adj[b.dataset.param]));
  showAdjVal();
  const f = S.doc.filter.id;
  document.querySelectorAll('#filterThumbs [data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
  $('filterRow').hidden = f === 'none';
  $('filterRange').hidden = f === 'none';
  $('filterName').textContent = f === 'none' ? '' : `Сила фильтра «${filterById(f).name}»`;
  document.querySelectorAll('#aspectChips [data-aspect]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aspect === (S.doc.geom.aspect || 'free'))));
  document.querySelectorAll('[data-bmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bmode === S.brush.mode)));
  document.querySelectorAll('.sw.brush').forEach((b) => b.setAttribute('aria-pressed', String(S.brush.mode === 'paint' && b.dataset.color === S.brush.color)));
  const t = selectedText();
  $('textEdit').disabled = !t;
  $('textDelete').disabled = !t;
  $('textSize').disabled = !t;
  document.querySelectorAll('.sw.text').forEach((b) => {
    b.disabled = !t;
    b.setAttribute('aria-pressed', String(!!t && b.dataset.color === t.color));
  });
  if (t) $('textSize').value = Math.round(textSizeToSlider(t.size));
}

/* ---------- размер текста: ползунок в тысячных долях длинной стороны ---------- */
function textSizeToSlider(size) {
  const [cw, ch] = outputSize(S.src.w, S.src.h, S.doc.geom, true);
  return (size * scaleOf(frameMatrix(S.src.w, S.src.h, S.doc.geom, 1, true)) * 1000) / Math.max(cw, ch);
}
function sliderToTextSize(v) {
  const [cw, ch] = outputSize(S.src.w, S.src.h, S.doc.geom, true);
  return ((v / 1000) * Math.max(cw, ch)) / scaleOf(frameMatrix(S.src.w, S.src.h, S.doc.geom, 1, true));
}

/* ---------- жесты ---------- */
const pointers = new Map();
let gesture = null;
const pt = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
function brushScreenToSource(px) {
  return px / scaleOf(screenM());
}

canvas.addEventListener('pointerdown', (e) => {
  if (!S.src || S.comparing) return;
  canvas.setPointerCapture(e.pointerId);
  const p = pt(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) {
    cancelLive();
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: [(a.x + b.x) / 2, (a.y + b.y) / 2], view0: { ...S.view } };
    return;
  }
  if (pointers.size > 2) return;
  const pan = { type: 'pan', start: p, view0: { ...S.view }, moved: false };
  switch (S.mode) {
    case 'crop': {
      const handle = hitCrop(p);
      gesture = handle ? { type: 'crop', handle, start: p, crop0: { ...S.doc.geom.crop }, moved: false } : pan;
      break;
    }
    case 'brush':
      startStroke(p);
      gesture = { type: 'paint', start: p };
      break;
    case 'heal': {
      const r = brushScreenToSource(S.healSize / 2);
      const q = toSource(p);
      healTrail = { r, pts: [q], screen: [[p.x, p.y, S.healSize / 2]] };
      gesture = { type: 'heal', start: p };
      redraw();
      break;
    }
    case 'text': {
      const t = hitText(p);
      if (t) {
        S.selText = t.id;
        gesture = { type: 'text', id: t.id, start: p, orig: [t.x, t.y], moved: false };
      } else {
        S.selText = null;
        gesture = pan;
      }
      updateUI();
      redraw();
      break;
    }
    default:
      gesture = pan;
  }
  if (e.pointerType === 'mouse' && (S.mode === 'brush' || S.mode === 'heal')) setCursor(p);
});

canvas.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (!pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse' && S.src && (S.mode === 'brush' || S.mode === 'heal')) setCursor(p);
    return;
  }
  pointers.set(e.pointerId, p);
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const v0 = gesture.view0;
    const ns = clamp(v0.s * (d / gesture.d0), 0.02, 60);
    const wx = (gesture.mid0[0] - v0.tx) / v0.s;
    const wy = (gesture.mid0[1] - v0.ty) / v0.s;
    S.view = { s: ns, tx: mid[0] - wx * ns, ty: mid[1] - wy * ns };
    redraw();
    return;
  }
  const dx = p.x - gesture.start.x;
  const dy = p.y - gesture.start.y;
  const far = Math.hypot(dx, dy) > 5;
  switch (gesture.type) {
    case 'pan':
      if (!far && !gesture.moved) return;
      gesture.moved = true;
      S.view = { ...S.view, tx: gesture.view0.tx + dx, ty: gesture.view0.ty + dy };
      redraw();
      break;
    case 'crop': {
      if (!far && !gesture.moved) return;
      if (!gesture.moved) beginSession();
      gesture.moved = true;
      const [fw, fh] = orientedSize(S.src.w, S.src.h, S.doc.geom.rot);
      S.doc.geom = { ...S.doc.geom, crop: dragCrop(gesture.crop0, gesture.handle, dx / S.view.s, dy / S.view.s, fw, fh, currentRatio(), 40 / S.view.s) };
      ver.crop++;
      redraw();
      break;
    }
    case 'paint':
      moveStroke(p);
      if (e.pointerType !== 'mouse') setCursor(p);
      break;
    case 'heal': {
      const q = toSource(p);
      const last = healTrail.pts[healTrail.pts.length - 1];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= healTrail.r * 0.8) {
        healTrail.pts.push(q);
        healTrail.screen.push([p.x, p.y, S.healSize / 2]);
      }
      setCursor(p);
      break;
    }
    case 'text': {
      if (!far && !gesture.moved) return;
      const t = selectedText();
      if (!t) return;
      if (!gesture.moved) {
        beginSession();
        const copy = { ...t };
        S.doc.texts = S.doc.texts.map((x) => (x.id === t.id ? copy : x));
      }
      gesture.moved = true;
      const inv = invert(screenM());
      const cur = selectedText();
      const a = applyM(inv, [gesture.start.x, gesture.start.y]);
      const b = applyM(inv, [p.x, p.y]);
      cur.x = gesture.orig[0] + b[0] - a[0];
      cur.y = gesture.orig[1] + b[1] - a[1];
      redraw();
      break;
    }
    default:
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;
  if (g && g.type === 'pinch') {
    if (pointers.size < 2) {
      gesture = null;
      requestRender(false);
    }
    return;
  }
  gesture = null;
  if (!g) return;
  if (e.type === 'pointercancel') {
    cancelLive();
    if (session) endSession();
    return;
  }
  switch (g.type) {
    case 'pan':
      if (g.moved) requestRender(false);
      break;
    case 'crop':
      if (g.moved) {
        endSession();
        requestRender(false);
      }
      break;
    case 'paint':
      endStroke();
      hideCursorSoon();
      break;
    case 'heal': {
      const t = healTrail;
      healTrail = null;
      hideCursorSoon();
      if (t && t.pts.length) {
        const spots = t.pts.map(([x, y]) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, r: Math.round(t.r * 10) / 10 }));
        commit((d) => { d.spots = d.spots.concat(spots); });
      } else redraw();
      break;
    }
    case 'text':
      if (g.moved) endSession();
      break;
    default:
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && !pointers.size && cursor) {
    cursor = null;
    redraw();
  }
});
canvas.addEventListener('wheel', (e) => {
  if (!S.src) return;
  e.preventDefault();
  const p = pt(e);
  const f = Math.exp(-e.deltaY * 0.0015);
  const v = S.view;
  const ns = clamp(v.s * f, 0.02, 60);
  S.view = { s: ns, tx: p.x - ((p.x - v.tx) * ns) / v.s, ty: p.y - ((p.y - v.ty) * ns) / v.s };
  redraw();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => requestRender(false), 200);
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function setCursor(p) {
  const r = S.mode === 'heal' ? S.healSize / 2 : S.brush.size / 2;
  cursor = { x: p.x, y: p.y, r };
  clearTimeout(cursorTimer);
  redraw();
}
function hideCursorSoon(ms = 350) {
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => { cursor = null; redraw(); }, ms);
}
function previewCursor(r) {
  cursor = { x: cssW / 2, y: cssH / 2, r };
  redraw();
  hideCursorSoon(700);
}

/* ---------- мазок кисти ---------- */
let liveTmp = null;
function startStroke(p) {
  const L = cache.layout;
  if (!L) return;
  const st = {
    mode: S.brush.mode,
    color: S.brush.color,
    size: Math.round(brushScreenToSource(S.brush.size) * 100) / 100,
    soft: S.brush.soft,
    opacity: S.brush.opacity,
    pts: [toSource(p).map((v) => Math.round(v * 10) / 10)],
  };
  liveTmp = sized(liveTmp, L.ow, L.oh);
  const t = liveTmp.getContext('2d');
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.clearRect(0, 0, L.ow, L.oh);
  t.setTransform(L.M[0], L.M[1], L.M[2], L.M[3], L.M[4], L.M[5]);
  dab(t, strokeTip(st), st.pts[0], st.size / 2);
  live = { st, carry: 0, M: L.M };
  updateLivePaint();
}
function moveStroke(p) {
  if (!live) return;
  const q = toSource(p).map((v) => Math.round(v * 10) / 10);
  const pts = live.st.pts;
  const last = pts[pts.length - 1];
  if (Math.hypot(q[0] - last[0], q[1] - last[1]) * scaleOf(screenM()) < 1.5) return;
  pts.push(q);
  const t = liveTmp.getContext('2d');
  live.carry = stampSegment(t, strokeTip(live.st), live.st.size / 2, last, q, spacingOf(live.st, live.M), live.carry);
  updateLivePaint();
}
function updateLivePaint() {
  const L = cache.layout;
  livePaint = sized(livePaint, L.ow, L.oh);
  const c = livePaint.getContext('2d');
  c.globalCompositeOperation = 'copy';
  c.drawImage(cache.paint, 0, 0);
  c.globalCompositeOperation = 'source-over';
  compositeStroke(c, liveTmp, live.st, { x: 0, y: 0, w: L.ow, h: L.oh });
  redraw();
}
function endStroke() {
  if (!live) return;
  const st = live.st;
  const L = cache.layout;
  // Сразу переносим мазок в слой рисунка, чтобы не перерисовывать все мазки заново.
  const c = cache.paint.getContext('2d');
  compositeStroke(c, liveTmp, st, { x: 0, y: 0, w: L.ow, h: L.oh });
  live = null;
  history.push(S.doc);
  S.doc.strokes = S.doc.strokes.concat([st]);
  ver.paint++;
  cache.paintKey = cache.paintKey.replace(/^\d+/, String(ver.paint));
  updateUI();
  saveSoon();
  redraw();
}
function cancelLive() {
  if (live) {
    live = null;
    redraw();
  }
  if (healTrail) {
    healTrail = null;
    redraw();
  }
}

/* ---------- кнопки и панели ---------- */
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('pUndo').addEventListener('click', undo);
$('pRedo').addEventListener('click', redo);
$('pFit').addEventListener('click', () => { fitView(); requestRender(false); });
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (e.shiftKey) redo(); else undo();
});

const cmp = $('pCompare');
const compareOn = (e) => {
  if (!S.src) return;
  e.preventDefault();
  S.comparing = true;
  $('pBadge').hidden = false;
  redraw();
};
const compareOff = () => {
  if (!S.comparing) return;
  S.comparing = false;
  $('pBadge').hidden = true;
  redraw();
};
cmp.addEventListener('pointerdown', compareOn);
cmp.addEventListener('pointerup', compareOff);
cmp.addEventListener('pointerleave', compareOff);
cmp.addEventListener('pointercancel', compareOff);
cmp.addEventListener('contextmenu', (e) => e.preventDefault());
cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') compareOn(e); });
cmp.addEventListener('keyup', compareOff);

// Коррекция
$('adjChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.auto) { runAuto(); return; }
  selectParam(b.dataset.param);
  b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
});
$('adjRange').addEventListener('input', (e) => {
  beginSession();
  S.doc.adj[S.param] = +e.target.value;
  ver.adj++;
  showAdjVal();
  requestRender(true);
});
$('adjRange').addEventListener('change', endSession);
$('adjReset').addEventListener('click', () => {
  if (!S.doc.adj[S.param]) return;
  commit((d) => { d.adj = { ...d.adj, [S.param]: 0 }; }, ['adj']);
  $('adjRange').value = 0;
});
$('adjName').addEventListener('dblclick', () => $('adjReset').click());

function runAuto() {
  const img = renderSmall(360);
  const p = autoParams(img);
  const same = Object.keys(p).every((k) => (S.doc.adj[k] || 0) === p[k]);
  if (same) { toast('Свет и цвет уже подобраны.'); return; }
  commit((d) => { d.adj = { ...d.adj, ...p }; }, ['adj']);
  selectParam(S.param);
  toast('Свет и цвет подобраны автоматически. Любой ползунок можно подвинуть.');
}

// Фильтры
$('filterThumbs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  const id = b.dataset.filter;
  if (id === S.doc.filter.id) return;
  commit((d) => { d.filter = { id, amount: 100 }; }, ['adj']);
  syncControls();
});
$('filterRange').addEventListener('input', (e) => {
  beginSession();
  S.doc.filter.amount = +e.target.value;
  $('filterVal').textContent = e.target.value;
  ver.adj++;
  requestRender(true);
});
$('filterRange').addEventListener('change', endSession);

// Кадр
$('aspectChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-aspect]');
  if (!b) return;
  const id = b.dataset.aspect;
  commit((d) => {
    const g = { ...d.geom, aspect: id };
    const ratio = aspectRatio(id, S.src.w, S.src.h, g.rot);
    if (ratio) {
      const [fw, fh] = orientedSize(S.src.w, S.src.h, g.rot);
      g.crop = fitAspect(g.crop, ratio, fw, fh);
    }
    d.geom = g;
  }, ['crop']);
});
$('cropRotate').addEventListener('click', () => {
  commit((d) => { d.geom = rotateGeom(d.geom); }, ['geom', 'crop']);
  fitView();
});
$('cropFlip').addEventListener('click', () => {
  commit((d) => { d.geom = flipGeom(d.geom); }, ['geom', 'crop']);
  syncControls();
});
$('angleRange').addEventListener('input', (e) => {
  beginSession();
  S.doc.geom = { ...S.doc.geom, angle: +e.target.value };
  $('angleVal').textContent = formatAngle(+e.target.value);
  ver.geom++;
  requestRender(true);
});
$('angleRange').addEventListener('change', endSession);
$('cropReset').addEventListener('click', () => {
  commit((d) => { d.geom = { ...DEFAULT_GEOM, crop: { ...FULL } }; }, ['geom', 'crop']);
  fitView();
  syncControls();
});

// Кисть
function saveBrush() {
  try { localStorage.setItem(BRUSH_KEY, JSON.stringify({ ...S.brush, heal: S.healSize })); } catch (e) { /* без сохранения */ }
}
function loadBrush() {
  try {
    const b = JSON.parse(localStorage.getItem(BRUSH_KEY) || 'null');
    if (b) {
      Object.assign(S.brush, { color: b.color || S.brush.color, size: b.size || S.brush.size, soft: b.soft ?? S.brush.soft, opacity: b.opacity || S.brush.opacity });
      S.healSize = b.heal || S.healSize;
    }
  } catch (e) { /* ничего */ }
  $('brushColor').value = S.brush.color;
  $('brushSize').value = S.brush.size;
  $('brushSoft').value = S.brush.soft;
  $('brushOpacity').value = S.brush.opacity;
  $('healSize').value = S.healSize;
}
document.querySelectorAll('[data-bmode]').forEach((b) => b.addEventListener('click', () => {
  S.brush.mode = b.dataset.bmode;
  updateUI();
}));
$('brushSwatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  S.brush.color = b.dataset.color;
  S.brush.mode = 'paint';
  $('brushColor').value = S.brush.color;
  saveBrush();
  updateUI();
});
$('brushColor').addEventListener('input', (e) => {
  S.brush.color = e.target.value;
  S.brush.mode = 'paint';
  saveBrush();
  updateUI();
});
$('brushSize').addEventListener('input', (e) => { S.brush.size = +e.target.value; previewCursor(S.brush.size / 2); saveBrush(); });
$('brushSoft').addEventListener('input', (e) => { S.brush.soft = +e.target.value; saveBrush(); });
$('brushOpacity').addEventListener('input', (e) => { S.brush.opacity = +e.target.value; saveBrush(); });
$('healSize').addEventListener('input', (e) => { S.healSize = +e.target.value; previewCursor(S.healSize / 2); saveBrush(); });

// Текст
let textEditing = null;
function openTextSheet(t) {
  textEditing = t ? t.id : null;
  $('textTitle').textContent = t ? 'Изменить текст' : 'Новый текст';
  $('textInput').value = t ? t.text : '';
  const font = t ? t.font : 'sans';
  document.querySelector(`input[name=tfont][value=${font}]`).checked = true;
  $('textOutline').checked = t ? !!t.outline : false;
  $('textShadow').checked = t ? !!t.shadow : true;
  $('textSheet').showModal();
  setTimeout(() => $('textInput').focus(), 50);
}
$('textAdd').addEventListener('click', () => openTextSheet(null));
$('textEdit').addEventListener('click', () => { const t = selectedText(); if (t) openTextSheet(t); });
$('textCancel').addEventListener('click', () => $('textSheet').close());
$('textForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('textInput').value.replace(/\s+$/, '');
  $('textSheet').close();
  if (!text.trim()) return;
  const font = document.querySelector('input[name=tfont]:checked').value;
  const outline = $('textOutline').checked;
  const shadow = $('textShadow').checked;
  if (textEditing) {
    const id = textEditing;
    commit((d) => { d.texts = d.texts.map((t) => (t.id === id ? { ...t, text, font, outline, shadow } : t)); });
  } else {
    // Ставим текст в центр экрана, а если там нет фото — в центр кадра.
    const { cw, ch } = layoutNow();
    let u = [(cssW / 2 - S.view.tx) / S.view.s, (cssH / 2 - S.view.ty) / S.view.s];
    if (u[0] < 0 || u[1] < 0 || u[0] > cw || u[1] > ch) u = [cw / 2, ch / 2];
    const c = applyM(invert(frameM1()), u);
    const t = {
      id: 't' + textIdSeq++, text, font, outline, shadow,
      x: Math.round(c[0]), y: Math.round(c[1]),
      size: sliderToTextSize(80), color: '#ffffff', opacity: 1, visible: true,
    };
    commit((d) => { d.texts = d.texts.concat([t]); });
    S.selText = t.id;
    updateUI();
    toast('Текст можно перетащить пальцем.');
  }
});
$('textDelete').addEventListener('click', () => {
  const id = S.selText;
  if (!id) return;
  commit((d) => { d.texts = d.texts.filter((t) => t.id !== id); });
  S.selText = null;
  updateUI();
});
$('textSwatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  const t = selectedText();
  if (!b || !t) return;
  commit((d) => { d.texts = d.texts.map((x) => (x.id === t.id ? { ...x, color: b.dataset.color } : x)); });
});
$('textSize').addEventListener('input', (e) => {
  const t = selectedText();
  if (!t) return;
  if (!session) {
    beginSession();
    S.doc.texts = S.doc.texts.map((x) => (x.id === t.id ? { ...x } : x));
  }
  selectedText().size = sliderToTextSize(+e.target.value);
  redraw();
});
$('textSize').addEventListener('change', endSession);

// Слои
function renderLayers() {
  const list = $('layersList');
  const rows = [];
  const eye = (on) => `<svg viewBox="0 0 24 24" aria-hidden="true">${on ? '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>' : '<path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.2 7.4C3.6 9.2 2 12 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4.2-.9"/>'}</svg>`;
  for (let i = S.doc.texts.length - 1; i >= 0; i--) {
    const t = S.doc.texts[i];
    const on = t.visible !== false;
    const name = t.text.split('\n')[0];
    rows.push(`<div class="layer" data-text="${t.id}">
      <button type="button" class="eye" data-act="vis" aria-pressed="${on}" aria-label="${on ? 'Скрыть' : 'Показать'} текст">${eye(on)}</button>
      <div class="layer-main"><b>Текст «${escapeHtml(name.length > 18 ? name.slice(0, 18) + '…' : name)}»</b>
      <input type="range" min="10" max="100" value="${Math.round((t.opacity ?? 1) * 100)}" data-act="op" aria-label="Непрозрачность текста"></div>
      <button type="button" class="chip-btn" data-act="del">Удалить</button></div>`);
  }
  const pOn = S.doc.paint.visible;
  const n = S.doc.strokes.length;
  rows.push(`<div class="layer" data-paint="1">
    <button type="button" class="eye" data-act="vis" aria-pressed="${pOn}" aria-label="${pOn ? 'Скрыть' : 'Показать'} рисунок">${eye(pOn)}</button>
    <div class="layer-main"><b>Рисунок</b><span>${n ? plural(n, 'мазок', 'мазка', 'мазков') : 'пока пусто'}</span>
    <input type="range" min="10" max="100" value="${Math.round(S.doc.paint.opacity * 100)}" data-act="op" aria-label="Непрозрачность рисунка"></div>
    <button type="button" class="chip-btn" data-act="clear" ${n ? '' : 'disabled'}>Очистить</button></div>`);
  const parts = [];
  if (!isIdentity(S.doc.adj)) parts.push('коррекция');
  if (S.doc.filter.id !== 'none') parts.push(`фильтр «${filterById(S.doc.filter.id).name}»`);
  if (S.doc.spots.length) parts.push('ретушь: ' + plural(S.doc.spots.length, 'точка', 'точки', 'точек'));
  rows.push(`<div class="layer" data-photo="1">
    <span class="eye static" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/></svg></span>
    <div class="layer-main"><b>Фото</b><span>${parts.length ? parts.join(', ') : 'без правок'}</span></div>
    <button type="button" class="chip-btn" data-act="unheal" ${S.doc.spots.length ? '' : 'disabled'}>Убрать ретушь</button></div>`);
  list.innerHTML = rows.join('');
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}
$('pLayers').addEventListener('click', () => { renderLayers(); $('layersSheet').showModal(); });
$('layersList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const row = b.closest('.layer');
  const act = b.dataset.act;
  if (row.dataset.text) {
    const id = row.dataset.text;
    if (act === 'vis') commit((d) => { d.texts = d.texts.map((t) => (t.id === id ? { ...t, visible: t.visible === false } : t)); });
    if (act === 'del') {
      commit((d) => { d.texts = d.texts.filter((t) => t.id !== id); });
      if (S.selText === id) S.selText = null;
    }
  } else if (row.dataset.paint) {
    if (act === 'vis') commit((d) => { d.paint = { ...d.paint, visible: !d.paint.visible }; });
    if (act === 'clear') commit((d) => { d.strokes = []; }, ['paint']);
  } else if (row.dataset.photo && act === 'unheal') {
    commit((d) => { d.spots = []; });
  }
  renderLayers();
});
$('layersList').addEventListener('input', (e) => {
  const r = e.target.closest('input[data-act=op]');
  if (!r) return;
  const row = r.closest('.layer');
  beginSession();
  const v = +r.value / 100;
  if (row.dataset.text) S.doc.texts = S.doc.texts.map((t) => (t.id === row.dataset.text ? { ...t, opacity: v } : t));
  else S.doc.paint = { ...S.doc.paint, opacity: v };
  redraw();
});
$('layersList').addEventListener('change', endSession);

/* ---------- открыть фото ---------- */
$('pPick').addEventListener('click', () => $('pFile').click());
$('pCamera').addEventListener('click', () => $('pCam').click());
$('pSample').addEventListener('click', openSample);
for (const id of ['pFile', 'pCam']) {
  $(id).addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) openFile(f);
  });
}

async function openFile(file) {
  busy('Открываю фото…');
  await nextFrame();
  let url = '';
  try {
    url = URL.createObjectURL(file);
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, MAX_SRC / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
    let blob = file;
    if (scale < 1 || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
      const c = sized(null, Math.round(w * scale), Math.round(h * scale));
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      blob = await toBlob(c, 'image/jpeg', 0.95);
    }
    await setSource(blob, newDoc());
    idbSet('raster-src', blob);
    saveNow();
    toast('Фото открыто. Начни с «Авто» или подвинь ползунки.');
  } catch (err) {
    console.error(err);
    toast('Это фото не открылось. Попробуй JPG или PNG.');
  } finally {
    if (url) URL.revokeObjectURL(url);
    busy('');
  }
}

async function setSource(blob, doc) {
  const url = URL.createObjectURL(blob);
  const img = await loadImage(url);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (S.src && S.src.url) URL.revokeObjectURL(S.src.url);
  S.src = { img, w, h, url };
  const ps = Math.min(1, PREV_SIDE / Math.max(w, h));
  const prev = sized(null, Math.max(1, Math.round(w * ps)), Math.max(1, Math.round(h * ps)));
  const ctx = prev.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, prev.width, prev.height);
  S.prev = prev;
  S.prevScale = prev.width / w;
  S.doc = doc;
  S.selText = null;
  textIdSeq = doc.texts.reduce((m, t) => Math.max(m, +String(t.id).slice(1) || 0), 0) + 1;
  history.clear();
  Object.assign(cache, { healed: null, healedData: null, healedFor: null, photoKey: '', paintKey: '', originalKey: '', thumbsKey: '', histKey: '', layout: null });
  for (const k of Object.keys(ver)) ver[k]++;
  if (S.mode === 'crop') S.mode = 'adjust';
  setMode(S.mode);
  updateUI();
  onStageResize();
  sizeCanvas();
  fitView();
  syncControls();
  requestRender(false);
  updateUI();
}

/** Пример: вечернее море с пылинками в небе — удобно попробовать «Авто» и «Ретушь». */
async function openSample() {
  busy('Готовлю пример…');
  await nextFrame();
  const W = 1600, H = 1067;
  const c = sized(null, W, H);
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, H * 0.62);
  sky.addColorStop(0, '#6f8fb8');
  sky.addColorStop(0.55, '#e3a58f');
  sky.addColorStop(1, '#f6d2a8');
  x.fillStyle = sky;
  x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(W * 0.68, H * 0.55, 10, W * 0.68, H * 0.55, H * 0.55);
  glow.addColorStop(0, 'rgba(255,240,200,0.95)');
  glow.addColorStop(1, 'rgba(255,200,150,0)');
  x.fillStyle = glow;
  x.fillRect(0, 0, W, H);
  x.fillStyle = '#fff4d8';
  x.beginPath(); x.arc(W * 0.68, H * 0.56, 46, 0, Math.PI * 2); x.fill();
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const ridge = (base, amp, color) => {
    x.fillStyle = color;
    x.beginPath();
    x.moveTo(0, H);
    let y = base;
    for (let i = 0; i <= W; i += 20) {
      y += (rnd() - 0.5) * amp;
      y = Math.min(base + amp * 2, Math.max(base - amp * 2, y));
      x.lineTo(i, y);
    }
    x.lineTo(W, H);
    x.fill();
  };
  ridge(H * 0.5, 16, 'rgba(150,125,160,0.65)');
  ridge(H * 0.56, 12, 'rgba(118,96,138,0.8)');
  const sea = x.createLinearGradient(0, H * 0.6, 0, H);
  sea.addColorStop(0, '#d7a898');
  sea.addColorStop(1, '#5d6f8a');
  x.fillStyle = sea;
  x.fillRect(0, H * 0.6, W, H * 0.4);
  for (let i = 0; i < 160; i++) {
    const yy = H * 0.61 + Math.pow(rnd(), 1.6) * H * 0.3;
    const len = 12 + rnd() * 70;
    const xx = W * 0.68 + (rnd() - 0.5) * (40 + (yy - H * 0.6) * 0.9);
    x.fillStyle = `rgba(255,236,200,${0.25 + rnd() * 0.5})`;
    x.fillRect(xx - len / 2, yy, len, 2 + rnd() * 2);
  }
  x.fillStyle = '#c8a189';
  x.beginPath();
  x.moveTo(0, H * 0.86);
  x.quadraticCurveTo(W * 0.35, H * 0.78, W * 0.62, H * 0.9);
  x.quadraticCurveTo(W * 0.82, H * 0.98, W, H * 0.92);
  x.lineTo(W, H); x.lineTo(0, H); x.fill();
  x.strokeStyle = 'rgba(60,40,55,0.8)';
  x.lineWidth = 3;
  x.lineCap = 'round';
  for (const [bx, by, s] of [[380, 230, 14], [430, 205, 10], [470, 245, 12]]) {
    x.beginPath();
    x.moveTo(bx - s, by - s * 0.4); x.quadraticCurveTo(bx - s * 0.4, by - s * 0.6, bx, by);
    x.quadraticCurveTo(bx + s * 0.4, by - s * 0.6, bx + s, by - s * 0.4);
    x.stroke();
  }
  // Пылинки на «матрице», как на настоящем снимке.
  for (const [dx, dy, r] of [[250, 120, 11], [1180, 170, 9], [900, 300, 13], [1400, 90, 8]]) {
    const g = x.createRadialGradient(dx, dy, 0, dx, dy, r);
    g.addColorStop(0, 'rgba(70,45,60,0.45)');
    g.addColorStop(1, 'rgba(70,45,60,0)');
    x.fillStyle = g;
    x.fillRect(dx - r, dy - r, r * 2, r * 2);
  }
  // Лёгкий шум и «блёклость», чтобы было что улучшать.
  const id = x.getImageData(0, 0, W, H);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    d[i] = 24 + d[i] * 0.84 + n;
    d[i + 1] = 24 + d[i + 1] * 0.84 + n;
    d[i + 2] = 30 + d[i + 2] * 0.84 + n;
  }
  x.putImageData(id, 0, 0);
  const blob = await toBlob(c, 'image/jpeg', 0.92);
  await setSource(blob, newDoc());
  idbSet('raster-src', blob);
  saveNow();
  busy('');
  toast('Попробуй «Авто», а в «Ретуши» — убрать пылинки в небе.', 4200);
}

/* ---------- сохранение проекта ---------- */
let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!S.src) return;
  idbSet('raster-doc', JSON.parse(JSON.stringify(S.doc)));
  saveThumb();
}
function saveThumb() {
  try {
    if (!cache.photo || !cache.layout) return;
    const L = cache.layout;
    const k = 180 / Math.max(L.ow, L.oh);
    const c = sized(null, Math.max(1, Math.round(L.ow * k)), Math.max(1, Math.round(L.oh * k)));
    const ctx = c.getContext('2d');
    ctx.drawImage(cache.photo, 0, 0, c.width, c.height);
    if (S.doc.paint.visible && cache.paint) {
      ctx.globalAlpha = S.doc.paint.opacity;
      ctx.drawImage(cache.paint, 0, 0, c.width, c.height);
      ctx.globalAlpha = 1;
    }
    const Mt = mul([c.width / L.ow, 0, 0, c.height / L.oh, 0, 0], L.M);
    for (const t of S.doc.texts) if (t.visible !== false) drawText(ctx, t, Mt);
    localStorage.setItem(THUMB_KEY, c.toDataURL('image/jpeg', 0.72));
  } catch (e) { /* не страшно */ }
}
window.addEventListener('pagehide', () => { if (S.src) saveNow(); });

/* ---------- экспорт ---------- */
function exportDims(maxSide) {
  const [cw, ch] = outputSize(S.src.w, S.src.h, S.doc.geom, true);
  const k = maxSide ? Math.min(1, maxSide / Math.max(cw, ch)) : 1;
  return { k, ow: Math.max(1, Math.round(cw * k)), oh: Math.max(1, Math.round(ch * k)) };
}

async function renderExport(maxSide, type) {
  const { k, ow, oh } = exportDims(maxSide);
  const g = S.doc.geom;
  const M = frameMatrix(S.src.w, S.src.h, g, k, true);
  // Фото с ретушью: в том разрешении, которого хватит для результата.
  const bs = Math.min(1, scaleOf(M) * 1.15);
  let base = S.src.img;
  if (S.doc.spots.length || bs < 1) {
    const bc = sized(null, Math.max(1, Math.round(S.src.w * bs)), Math.max(1, Math.round(S.src.h * bs)), { willReadFrequently: true });
    const bctx = bc.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(S.src.img, 0, 0, bc.width, bc.height);
    if (S.doc.spots.length) {
      const data = bctx.getImageData(0, 0, bc.width, bc.height);
      const sx = bc.width / S.src.w;
      for (const s of S.doc.spots) healSpot(data, s.x * sx, s.y * sx, s.r * sx);
      bctx.putImageData(data, 0, 0);
    }
    base = bc;
  }
  await nextFrame();
  const out = sized(null, ow, oh, { willReadFrequently: true });
  const ctx = out.getContext('2d', { willReadFrequently: true });
  drawBase(ctx, base, M, ow, oh);
  base = null;
  const params = effectiveParams();
  if (!isIdentity(params)) {
    const id = ctx.getImageData(0, 0, ow, oh);
    applyAdjustments(id, params);
    ctx.putImageData(id, 0, 0);
  }
  await nextFrame();
  if (S.doc.paint.visible && S.doc.strokes.length) {
    const pc = sized(null, ow, oh);
    renderStrokes(pc.getContext('2d'), S.doc.strokes, M, ow, oh);
    ctx.globalAlpha = S.doc.paint.opacity;
    ctx.drawImage(pc, 0, 0);
    ctx.globalAlpha = 1;
    strokeTmp = null;
  }
  for (const t of S.doc.texts) if (t.visible !== false) drawText(ctx, t, M);
  return toBlob(out, type === 'png' ? 'image/png' : 'image/jpeg', 0.92);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function exportChoice() {
  return {
    type: document.querySelector('input[name=efmt]:checked').value,
    maxSide: +document.querySelector('input[name=esize]:checked').value,
  };
}
async function doExport(share) {
  const { type, maxSide } = exportChoice();
  $('pExportSheet').close();
  busy('Готовлю фото в полном качестве…');
  await nextFrame();
  try {
    await document.fonts.ready;
    const blob = await renderExport(maxSide, type);
    if (!blob) throw new Error('пустой файл');
    const name = `photo-${stamp()}.${type === 'png' ? 'png' : 'jpg'}`;
    if (share) {
      const file = new File([blob], name, { type: blob.type });
      busy('');
      try {
        await navigator.share({ files: [file], title: 'Фото' });
      } catch (e) {
        if (e && e.name !== 'AbortError') download(blob, name);
      }
    } else {
      download(blob, name);
      toast('Фото сохранено в «Загрузки».');
    }
  } catch (e) {
    console.error(e);
    toast('Не получилось сохранить. Попробуй размер поменьше.');
  } finally {
    busy('');
  }
}
$('pExport').addEventListener('click', () => {
  const { ow, oh } = exportDims(0);
  $('eSizeFull').textContent = `Полный, ${ow}×${oh}`;
  let canShare = false;
  try {
    canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' })] }));
  } catch (e) { canShare = false; }
  $('pShare').hidden = !canShare;
  $('pExportSheet').showModal();
});
$('pDownload').addEventListener('click', () => doExport(false));
$('pShare').addEventListener('click', () => doExport(true));
$('pNewPhoto').addEventListener('click', () => { $('pExportSheet').close(); $('pFile').click(); });
$('pResetAll').addEventListener('click', () => {
  $('pExportSheet').close();
  commit((d) => {
    const fresh = newDoc();
    Object.assign(d, fresh);
  }, ['geom', 'crop', 'adj', 'paint']);
  S.selText = null;
  cache.healedFor = null;
  fitView();
  syncControls();
  toast('Все правки сброшены. Вернуть их — кнопка «Отменить».');
});

/* ---------- старт ---------- */
// Размер холста следим по самой области, а не по окну: панель инструментов появляется
// и меняет высоту, а клавиатура телефона может сжать экран.
let lastBox = '';
function onStageResize() {
  const r = wrap.getBoundingClientRect();
  const key = `${Math.round(r.width)}x${Math.round(r.height)}@${window.devicePixelRatio}`;
  if (key === lastBox) return;
  lastBox = key;
  sizeCanvas();
  if (S.src) { fitView(); requestRender(false); } else redraw();
}
if ('ResizeObserver' in window) new ResizeObserver(onStageResize).observe(wrap);
window.addEventListener('resize', onStageResize);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); redraw(); });
document.fonts && document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', redraw);

async function start() {
  readTheme();
  buildAdjChips();
  buildAspectChips();
  buildSwatches($('brushSwatches'), 'brush');
  buildSwatches($('textSwatches'), 'text');
  loadBrush();
  sizeCanvas();
  selectParam(S.param);
  updateUI();
  draw();
  try {
    const [blob, doc] = await Promise.all([idbGet('raster-src'), idbGet('raster-doc')]);
    if (blob) {
      busy('Открываю твоё фото…');
      const d = doc && doc.v === 1 ? { ...newDoc(), ...doc } : newDoc();
      await setSource(blob, d);
    }
  } catch (e) {
    console.error(e);
  } finally {
    busy('');
  }
  if (document.fonts) document.fonts.load('700 40px Caveat').then(redraw, () => {});
}
start();
