import test from 'node:test';
import assert from 'node:assert/strict';
import { quantize, components, traceLoops, traceImage, mergeSmall, fitSize } from '../app/src/trace.js';
import { polygonArea } from '../app/src/geometry.js';
import { makeImage } from './helpers.js';

const WHITE = [255, 255, 255], RED = [220, 40, 60], BLUE = [30, 60, 200];

test('палитра находит два цвета картинки', () => {
  const img = makeImage(40, 30, WHITE, [{ x: 10, y: 5, w: 15, h: 10, c: RED }]);
  const { palette, labels } = quantize(img, 2);
  assert.equal(palette.length, 2);
  const hasRed = palette.some((c) => Math.abs(c[0] - 220) < 3 && Math.abs(c[1] - 40) < 3);
  assert.ok(hasRed, 'красный найден: ' + JSON.stringify(palette));
  assert.equal(new Set(labels).size, 2);
});

test('в картинке меньше цветов, чем просили, — лишних не придумывает', () => {
  const img = makeImage(20, 20, WHITE, [{ x: 2, y: 2, w: 5, h: 5, c: RED }]);
  const { palette } = quantize(img, 8);
  assert.ok(palette.length <= 8);
  const counts = new Set(palette.map((c) => c.join(',')));
  assert.ok(counts.size >= 2);
});

test('связные области: фон и квадрат', () => {
  const w = 10, h = 10;
  const labels = new Int16Array(w * h);
  for (let y = 3; y < 6; y++) for (let x = 3; x < 6; x++) labels[y * w + x] = 1;
  const { info } = components(labels, w, h);
  assert.equal(info.length, 2);
  assert.deepEqual(info.map((c) => c.area).sort((a, b) => a - b), [9, 91]);
});

test('контур квадрата с дырой: внешний и внутренний обход с нужными площадями', () => {
  const w = 12, h = 12;
  const comp = new Int32Array(w * h).fill(0);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) comp[y * w + x] = 1;
  const loops = traceLoops(comp, w, h, 0);
  assert.equal(loops.length, 2);
  const areas = loops.map(polygonArea).sort((a, b) => a - b);
  assert.equal(Math.abs(areas[0]), 16); // дыра 4×4
  assert.equal(Math.abs(areas[1]), 144); // внешняя граница 12×12
  assert.ok(Math.sign(areas[0]) !== Math.sign(areas[1]), 'дыра обходится в обратную сторону');
});

test('диагональное касание не ломает обход', () => {
  const w = 4, h = 4;
  const comp = new Int32Array(w * h).fill(-1);
  // кольцо, которое касается само себя по диагонали
  [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [3, 2], [2, 3]].forEach(([x, y]) => { comp[y * w + x] = 0; });
  const loops = traceLoops(comp, w, h, 0);
  const total = loops.reduce((s, l) => s + polygonArea(l), 0);
  // сумма площадей со знаком (дыры с минусом) равна числу закрашенных пикселей
  assert.equal(Math.abs(total), 9);
  loops.forEach((l) => assert.ok(l.length >= 4));
});

test('мелкие пятна сливаются с соседями', () => {
  const w = 20, h = 20;
  const labels = new Int16Array(w * h);
  labels[5 * w + 5] = 1; // одинокий пиксель
  const merged = mergeSmall(labels, w, h, 4);
  assert.equal(merged[5 * w + 5], 0);
});

test('векторизация: фон и два прямоугольника дают три фигуры нужных цветов', () => {
  const img = makeImage(60, 40, WHITE, [
    { x: 5, y: 5, w: 20, h: 12, c: RED },
    { x: 35, y: 20, w: 15, h: 15, c: BLUE },
  ]);
  const res = traceImage(img, { colors: 3, minArea: 4 });
  assert.equal(res.width, 60);
  assert.equal(res.shapes.length, 3);
  assert.equal(res.background.toLowerCase(), '#ffffff');
  const red = res.shapes.find((s) => s.fill === '#dc283c');
  assert.ok(red, 'красная фигура есть: ' + res.shapes.map((s) => s.fill));
  assert.ok(Math.abs(Math.abs(polygonArea(red.pts)) - 240) < 10, 'площадь красного ≈ 240');
  assert.equal(res.shapes[0].fill, '#ffffff', 'самая большая фигура — фон, она внизу');
  assert.ok(res.shapes.every((s) => s.id && s.pts.length >= 3));
});

test('размер для векторизации сохраняет пропорции', () => {
  assert.deepEqual(fitSize(4000, 3000, 800), { width: 800, height: 600 });
  assert.deepEqual(fitSize(300, 200, 800), { width: 300, height: 200 });
});
