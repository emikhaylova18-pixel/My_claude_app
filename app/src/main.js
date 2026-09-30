// Вектор-студия: интерфейс редактора.
// Фигуры в проекте не меняются «на месте»: при правке создаётся новый объект.
// Поэтому история отмены хранит лишь список ссылок и почти не занимает памяти.

import { traceImage, fitSize } from './trace.js';
import { pathD, bbox, translate, pointSegmentDistance } from './geometry.js';
import { createHistory } from './history.js';
import { projectToSVG } from './svg.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const STORE_KEY = 'vector-studio-project-v1';
const DETAIL = {
  low: { side: 420, tolerance: 1.6 },
  mid: { side: 640, tolerance: 1.1 },
  high: { side: 900, tolerance: 0.8 },
};
const CLEAN = { keep: 4, some: 20, all: 70 };

const state = {
  project: null, // { width, height, background, smooth, outline, shapes: [{ id, fill, pts }], photo }
  sel: null,
  node: -1,
  tool: 'select',
  view: { s: 1, tx: 0, ty: 0 },
  showPhoto: false,
  photoOpacity: 0.5,
  pending: null, // выбранное фото до векторизации: { url, img }
};
const history = createHistory(40, (p) => ({ ...p, shapes: p.shapes.slice() }));
let idSeq = 1;

/* ---------- хранение ---------- */
function save() {
  if (!state.project) { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* нет доступа */ } return; }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.project));
  } catch (e) {
    // Слишком большой проект: сохраняем без фото.
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...state.project, photo: null })); } catch (e2) { /* ничего */ }
  }
}
let saveTimer = 0;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };
function load() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (p && Array.isArray(p.shapes) && p.width > 0) return p;
  } catch (e) { /* пусто */ }
  return null;
}

/* ---------- отрисовка ---------- */
const world = $('world');
const shapesG = $('shapes');
const overlay = $('overlay');
const stage = $('stage');

function shapeById(id) { return state.project && state.project.shapes.find((s) => s.id === id); }

function renderShapes() {
  const p = state.project;
  if (!p) { shapesG.innerHTML = ''; return; }
  const parts = [];
  for (const s of p.shapes) {
    const d = pathD(s.pts, p.smooth);
    if (p.outline) parts.push(`<path data-id="${s.id}" d="${d}" fill="transparent" stroke="#2a2226" stroke-width="1.2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`);
    else parts.push(`<path data-id="${s.id}" d="${d}" fill="${s.fill}" stroke="${s.fill}" stroke-width="0.6" stroke-linejoin="round"/>`);
  }
  shapesG.innerHTML = parts.join('');
  const paper = $('paper');
  paper.setAttribute('width', p.width);
  paper.setAttribute('height', p.height);
  paper.style.fill = p.outline ? '#fff' : p.background;
  const ph = $('photoLayer');
  if (p.photo && state.showPhoto) {
    ph.setAttribute('href', p.photo);
    ph.setAttribute('width', p.width);
    ph.setAttribute('height', p.height);
    ph.setAttribute('opacity', state.photoOpacity);
    ph.style.display = '';
  } else {
    ph.style.display = 'none';
  }
}

function renderOverlay() {
  overlay.innerHTML = '';
  const s = shapeById(state.sel);
  if (!s) return;
  const k = 1 / state.view.s;
  if (state.tool === 'nodes') {
    const outline = document.createElementNS(NS, 'path');
    outline.setAttribute('d', pathD(s.pts, state.project.smooth));
    outline.setAttribute('class', 'sel-path');
    overlay.appendChild(outline);
    s.pts.forEach(([x, y], i) => {
      const c = document.createElementNS(NS, 'rect');
      const r = 7 * k;
      c.setAttribute('x', x - r); c.setAttribute('y', y - r);
      c.setAttribute('width', 2 * r); c.setAttribute('height', 2 * r);
      c.setAttribute('rx', 2 * k);
      c.setAttribute('class', 'node' + (i === state.node ? ' on' : ''));
      c.dataset.node = i;
      overlay.appendChild(c);
    });
  } else {
    const b = bbox(s.pts);
    const pad = 4 * k;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', b.x - pad); r.setAttribute('y', b.y - pad);
    r.setAttribute('width', b.w + 2 * pad); r.setAttribute('height', b.h + 2 * pad);
    r.setAttribute('class', 'sel-box');
    overlay.appendChild(r);
  }
}

function applyView() {
  const { s, tx, ty } = state.view;
  world.setAttribute('transform', `translate(${tx} ${ty}) scale(${s})`);
}

function fit() {
  const p = state.project;
  if (!p) return;
  const r = stage.getBoundingClientRect();
  const pad = 24;
  const s = Math.min((r.width - pad * 2) / p.width, (r.height - pad * 2) / p.height);
  state.view.s = Math.max(0.05, s);
  state.view.tx = (r.width - p.width * state.view.s) / 2;
  state.view.ty = (r.height - p.height * state.view.s) / 2;
  applyView();
  renderOverlay();
}

function renderUI() {
  const has = !!state.project;
  $('welcome').hidden = has;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool)));
  $('btnUndo').disabled = !history.canUndo();
  $('btnRedo').disabled = !history.canRedo();
  $('btnDelete').disabled = !state.sel && state.node < 0;
  $('btnExport').disabled = !has;
  $('btnView').disabled = !has;
  const s = shapeById(state.sel);
  $('props').hidden = !s;
  $('opDelNode').hidden = !(state.tool === 'nodes' && state.node >= 0);
  if (s) {
    const cols = uniqueColors();
    $('swatches').innerHTML = cols.map((c) => `<button type="button" class="sw" data-color="${c}" style="background:${c}" aria-label="Цвет ${c}" aria-pressed="${c === s.fill}"></button>`).join('');
    $('fillInput').value = s.fill;
  }
}

function uniqueColors() {
  const seen = new Map();
  for (const s of state.project.shapes) seen.set(s.fill, (seen.get(s.fill) || 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map((e) => e[0]);
}

function renderAll() { renderShapes(); renderOverlay(); renderUI(); }

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- изменения проекта ---------- */
function commit(mutator) {
  history.push(state.project);
  mutator(state.project);
  renderAll();
  saveSoon();
}
function replaceShape(id, next) {
  state.project.shapes = state.project.shapes.map((s) => (s.id === id ? next : s));
}

/* ---------- векторизация ---------- */
function imageToData(img, side) {
  const { width, height } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height, side);
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { data: ctx.getImageData(0, 0, width, height), canvas: c };
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));

async function runTrace(img, opts) {
  $('busyText').textContent = 'Рисую схему…';
  $('busy').hidden = false;
  await nextFrame();
  try {
    const d = DETAIL[opts.detail] || DETAIL.mid;
    const { data, canvas } = imageToData(img, d.side);
    const t0 = performance.now();
    const res = traceImage(data, { colors: opts.colors, tolerance: d.tolerance, minArea: CLEAN[opts.clean] ?? 20 });
    const photo = canvas.toDataURL('image/jpeg', 0.82);
    if (state.project) history.push(state.project);
    state.project = {
      width: res.width,
      height: res.height,
      background: res.background,
      smooth: opts.smooth,
      outline: false,
      shapes: res.shapes.map((s) => ({ id: 'f' + idSeq++, fill: s.fill, pts: s.pts })),
      photo,
      settings: opts,
    };
    state.sel = null; state.node = -1; state.tool = 'select';
    renderAll();
    fit();
    save();
    toast(`Готово: ${res.shapes.length} фигур за ${Math.max(1, Math.round((performance.now() - t0) / 100) / 10)} с`);
  } catch (e) {
    console.error(e);
    toast('Не получилось обработать фото. Попробуй другое или меньше деталей.');
  } finally {
    $('busy').hidden = true;
  }
}

function readOpts() {
  return {
    colors: +$('optColors').value,
    detail: document.querySelector('input[name=detail]:checked').value,
    clean: document.querySelector('input[name=clean]:checked').value,
    smooth: $('optSmooth').checked,
  };
}

function openTraceSheet(url, img) {
  state.pending = { url, img };
  $('tracePreview').src = url;
  const s = state.project && state.project.settings;
  if (s) {
    $('optColors').value = s.colors;
    document.querySelector(`input[name=detail][value=${s.detail}]`).checked = true;
    document.querySelector(`input[name=clean][value=${s.clean}]`).checked = true;
    $('optSmooth').checked = s.smooth;
  }
  $('colorsOut').textContent = $('optColors').value;
  $('traceSheet').showModal();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Пример: простая картинка с домиком и солнцем, нарисованная прямо в браузере. */
function sampleImageURL() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 440;
  const x = c.getContext('2d');
  x.fillStyle = '#bfe3f5'; x.fillRect(0, 0, 640, 440);
  x.fillStyle = '#ffd35c'; x.beginPath(); x.arc(520, 90, 52, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#ffffff';
  [[120, 90, 46], [165, 80, 38], [200, 98, 34], [360, 70, 30], [392, 62, 26]].forEach(([cx, cy, r]) => { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); });
  x.fillStyle = '#86c07a'; x.beginPath(); x.moveTo(0, 330); x.quadraticCurveTo(170, 250, 340, 320); x.quadraticCurveTo(500, 380, 640, 300); x.lineTo(640, 440); x.lineTo(0, 440); x.fill();
  x.fillStyle = '#5f9e58'; x.beginPath(); x.moveTo(0, 390); x.quadraticCurveTo(260, 330, 640, 400); x.lineTo(640, 440); x.lineTo(0, 440); x.fill();
  x.fillStyle = '#e9967a'; x.fillRect(250, 230, 150, 120);
  x.fillStyle = '#a8456a'; x.beginPath(); x.moveTo(236, 234); x.lineTo(325, 160); x.lineTo(414, 234); x.fill();
  x.fillStyle = '#7a4a3a'; x.fillRect(305, 285, 36, 65);
  x.fillStyle = '#fff4c7'; x.fillRect(266, 256, 30, 26); x.fillRect(358, 256, 30, 26);
  return c.toDataURL('image/png');
}

/* ---------- координаты ---------- */
function toWorld(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return [(clientX - r.left - state.view.tx) / state.view.s, (clientY - r.top - state.view.ty) / state.view.s];
}

function zoomAt(factor, cx, cy) {
  const v = state.view;
  const r = stage.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const ns = Math.min(40, Math.max(0.05, v.s * factor));
  v.tx = px - ((px - v.tx) * ns) / v.s;
  v.ty = py - ((py - v.ty) * ns) / v.s;
  v.s = ns;
  applyView();
  renderOverlay();
}

/* ---------- жесты ---------- */
const pointers = new Map();
let gesture = null;

stage.addEventListener('pointerdown', (e) => {
  if (!state.project) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: [(a.x + b.x) / 2, (a.y + b.y) / 2], view0: { ...state.view } };
    return;
  }
  if (pointers.size > 2) return;
  const t = e.target;
  const start = { x: e.clientX, y: e.clientY, w: toWorld(e.clientX, e.clientY) };
  if (t.dataset && t.dataset.node !== undefined && state.tool === 'nodes') {
    state.node = +t.dataset.node;
    gesture = { type: 'node', start, id: state.sel, idx: state.node, orig: shapeById(state.sel).pts, moved: false };
    renderOverlay(); renderUI();
    return;
  }
  const id = t.dataset && t.dataset.id;
  if (id) {
    if (state.tool === 'nodes' && id === state.sel) {
      gesture = { type: 'addnode', start, id };
      return;
    }
    const changed = state.sel !== id;
    state.sel = id; state.node = -1;
    if (changed) { renderOverlay(); renderUI(); }
    gesture = state.tool === 'select' ? { type: 'move', start, id, orig: shapeById(id).pts, moved: false } : { type: 'tap', start };
    return;
  }
  gesture = { type: 'pan', start, view0: { ...state.view }, moved: false };
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    const v0 = gesture.view0;
    const r = stage.getBoundingClientRect();
    const ns = Math.min(40, Math.max(0.05, v0.s * (d / gesture.d0)));
    const mx0 = gesture.mid0[0] - r.left, my0 = gesture.mid0[1] - r.top;
    const wx = (mx0 - v0.tx) / v0.s, wy = (my0 - v0.ty) / v0.s;
    state.view.s = ns;
    state.view.tx = mid[0] - r.left - wx * ns;
    state.view.ty = mid[1] - r.top - wy * ns;
    applyView();
    return;
  }
  const dxs = e.clientX - gesture.start.x, dys = e.clientY - gesture.start.y;
  const far = Math.hypot(dxs, dys) > 6;
  if (gesture.type === 'pan') {
    if (!far && !gesture.moved) return;
    gesture.moved = true;
    state.view.tx = gesture.view0.tx + dxs;
    state.view.ty = gesture.view0.ty + dys;
    applyView();
  } else if (gesture.type === 'move') {
    if (!far && !gesture.moved) return;
    gesture.moved = true;
    const dx = dxs / state.view.s, dy = dys / state.view.s;
    gesture.dx = dx; gesture.dy = dy;
    const el = shapesG.querySelector(`[data-id="${gesture.id}"]`);
    if (el) el.setAttribute('transform', `translate(${dx} ${dy})`);
    const box = overlay.querySelector('.sel-box');
    if (box) box.setAttribute('transform', `translate(${dx} ${dy})`);
  } else if (gesture.type === 'node') {
    if (!far && !gesture.moved) return;
    gesture.moved = true;
    const w = toWorld(e.clientX, e.clientY);
    const pts = gesture.orig.slice();
    pts[gesture.idx] = [Math.round(w[0] * 10) / 10, Math.round(w[1] * 10) / 10];
    gesture.pts = pts;
    const el = shapesG.querySelector(`[data-id="${gesture.id}"]`);
    if (el) el.setAttribute('d', pathD(pts, state.project.smooth));
    const handle = overlay.querySelector(`[data-node="${gesture.idx}"]`);
    const k = 7 / state.view.s;
    if (handle) { handle.setAttribute('x', pts[gesture.idx][0] - k); handle.setAttribute('y', pts[gesture.idx][1] - k); }
    const line = overlay.querySelector('.sel-path');
    if (line) line.setAttribute('d', pathD(pts, state.project.smooth));
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;
  if (g && g.type === 'pinch') {
    if (pointers.size < 2) gesture = null;
    renderOverlay();
    return;
  }
  gesture = null;
  if (!g) return;
  if (g.type === 'pan' && !g.moved) {
    if (state.sel) { state.sel = null; state.node = -1; renderOverlay(); renderUI(); }
  } else if (g.type === 'move' && g.moved) {
    const s = shapeById(g.id);
    commit(() => replaceShape(g.id, { ...s, pts: translate(s.pts, g.dx, g.dy).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) }));
  } else if (g.type === 'node' && g.moved) {
    const s = shapeById(g.id);
    commit(() => replaceShape(g.id, { ...s, pts: g.pts }));
  } else if (g.type === 'addnode') {
    const w = g.start.w;
    const s = shapeById(g.id);
    let best = -1, bd = Infinity;
    for (let i = 0; i < s.pts.length; i++) {
      const d = pointSegmentDistance(w, s.pts[i], s.pts[(i + 1) % s.pts.length]);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd * state.view.s < 24) {
      const pts = s.pts.slice();
      pts.splice(best + 1, 0, [Math.round(w[0] * 10) / 10, Math.round(w[1] * 10) / 10]);
      state.node = best + 1;
      commit(() => replaceShape(g.id, { ...s, pts }));
      toast('Узел добавлен. Потяни его, чтобы изменить форму.');
    }
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
  if (!state.project) return;
  e.preventDefault();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

/* ---------- кнопки ---------- */
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  state.tool = b.dataset.tool;
  state.node = -1;
  if (state.tool === 'nodes' && !state.sel) toast('Выбери фигуру: коснись её, и появятся узлы.');
  renderOverlay(); renderUI();
}));

$('btnDelete').addEventListener('click', () => {
  if (state.tool === 'nodes' && state.node >= 0) { deleteNode(); return; }
  const id = state.sel;
  if (!id) return;
  commit((p) => { p.shapes = p.shapes.filter((s) => s.id !== id); });
  state.sel = null;
  renderAll();
});

function deleteNode() {
  const s = shapeById(state.sel);
  if (!s || state.node < 0) return;
  if (s.pts.length <= 3) { toast('У фигуры должно остаться хотя бы три узла.'); return; }
  const pts = s.pts.filter((_, i) => i !== state.node);
  state.node = -1;
  commit(() => replaceShape(s.id, { ...s, pts }));
}

$('btnUndo').addEventListener('click', () => {
  const prev = history.undo(state.project);
  if (!prev) return;
  state.project = prev;
  if (!shapeById(state.sel)) state.sel = null;
  state.node = -1;
  renderAll(); saveSoon();
});
$('btnRedo').addEventListener('click', () => {
  const next = history.redo(state.project);
  if (!next) return;
  state.project = next;
  if (!shapeById(state.sel)) state.sel = null;
  state.node = -1;
  renderAll(); saveSoon();
});

$('props').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !state.sel) return;
  const s = shapeById(state.sel);
  if (b.dataset.color) {
    if (b.dataset.color !== s.fill) commit(() => replaceShape(s.id, { ...s, fill: b.dataset.color }));
    return;
  }
  const op = b.dataset.op;
  if (op === 'front' || op === 'back') {
    commit((p) => {
      const arr = p.shapes.filter((x) => x.id !== s.id);
      if (op === 'front') arr.push(s); else arr.unshift(s);
      p.shapes = arr;
    });
    toast(op === 'front' ? 'Фигура поднята наверх.' : 'Фигура опущена вниз.');
  } else if (op === 'dup') {
    const copy = { id: 'f' + idSeq++, fill: s.fill, pts: translate(s.pts, 10, 10) };
    commit((p) => { const i = p.shapes.indexOf(s); p.shapes = p.shapes.slice(0, i + 1).concat([copy], p.shapes.slice(i + 1)); });
    state.sel = copy.id;
    renderAll();
  } else if (op === 'delnode') {
    deleteNode();
  }
});
$('fillInput').addEventListener('input', (e) => {
  const el = shapesG.querySelector(`[data-id="${state.sel}"]`);
  if (el && !state.project.outline) { el.setAttribute('fill', e.target.value); el.setAttribute('stroke', e.target.value); }
});
$('fillInput').addEventListener('change', (e) => {
  const s = shapeById(state.sel);
  if (s && e.target.value !== s.fill) commit(() => replaceShape(s.id, { ...s, fill: e.target.value }));
});

$('zoomIn').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(1.4, r.left + r.width / 2, r.top + r.height / 2); });
$('zoomOut').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(1 / 1.4, r.left + r.width / 2, r.top + r.height / 2); });
$('zoomFit').addEventListener('click', fit);

/* ---------- фото и настройки векторизации ---------- */
const pick = () => $('fileInput').click();
$('btnNew').addEventListener('click', pick);
$('welcomePick').addEventListener('click', pick);
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const url = URL.createObjectURL(f);
  try { openTraceSheet(url, await loadImage(url)); } catch (err) { toast('Это фото не открылось. Попробуй JPG или PNG.'); }
});
$('welcomeSample').addEventListener('click', async () => {
  const url = sampleImageURL();
  const img = await loadImage(url);
  runTrace(img, { colors: 10, detail: 'mid', clean: 'some', smooth: true });
});
$('optColors').addEventListener('input', () => { $('colorsOut').textContent = $('optColors').value; });
$('traceCancel').addEventListener('click', () => $('traceSheet').close());
$('traceForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('traceSheet').close();
  if (state.pending) runTrace(state.pending.img, readOpts());
});

/* ---------- вид ---------- */
$('btnView').addEventListener('click', () => {
  const p = state.project;
  if (!p) return;
  $('viewOutline').checked = !!p.outline;
  $('viewSmooth').checked = !!p.smooth;
  $('viewPhoto').checked = state.showPhoto;
  $('viewPhoto').disabled = !p.photo;
  $('retrace').disabled = !p.photo;
  $('viewPhotoOpacity').value = Math.round(state.photoOpacity * 100);
  $('viewStats').textContent = `Фигур: ${p.shapes.length}. Размер: ${p.width}×${p.height}.`;
  $('viewSheet').showModal();
});
$('viewOutline').addEventListener('change', (e) => { state.project.outline = e.target.checked; renderAll(); saveSoon(); });
$('viewSmooth').addEventListener('change', (e) => { state.project.smooth = e.target.checked; renderAll(); saveSoon(); });
$('viewPhoto').addEventListener('change', (e) => { state.showPhoto = e.target.checked; renderShapes(); });
$('viewPhotoOpacity').addEventListener('input', (e) => { state.photoOpacity = e.target.value / 100; renderShapes(); });
$('retrace').addEventListener('click', async () => {
  $('viewSheet').close();
  const p = state.project;
  if (!p || !p.photo) return;
  openTraceSheet(p.photo, await loadImage(p.photo));
});

/* ---------- сохранение файлов ---------- */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
$('btnExport').addEventListener('click', () => $('exportSheet').showModal());
$('dlSvg').addEventListener('click', () => {
  download(new Blob([projectToSVG(state.project)], { type: 'image/svg+xml' }), `vector-${stamp()}.svg`);
  toast('SVG сохранён в загрузки.');
});
$('dlPng').addEventListener('click', async () => {
  const p = state.project;
  const scale = Math.min(4, 2000 / Math.max(p.width, p.height));
  const svg = projectToSVG(p, { scale });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = Math.round(p.width * scale); c.height = Math.round(p.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.toBlob((b) => { download(b, `vector-${stamp()}.png`); toast('PNG сохранён в загрузки.'); }, 'image/png');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
});
$('clearProject').addEventListener('click', () => {
  $('exportSheet').close();
  history.clear();
  state.project = null; state.sel = null; state.node = -1;
  save(); renderAll();
});

/* ---------- старт ---------- */
window.addEventListener('resize', () => { if (state.project) fit(); });
state.project = load();
if (state.project) {
  idSeq = state.project.shapes.length + 10;
  state.project.shapes = state.project.shapes.map((s) => ({ ...s, id: 'f' + idSeq++ }));
}
renderAll();
requestAnimationFrame(fit);
