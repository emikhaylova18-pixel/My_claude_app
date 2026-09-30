import test from 'node:test';
import assert from 'node:assert/strict';
import { healSpot, healAll } from '../app/src/photo/heal.js';
import { FILTERS, combineParams } from '../app/src/photo/filters.js';
import { applyAdjustments, DEFAULTS, RANGE } from '../app/src/photo/adjust.js';
import { makeImage } from './helpers.js';

const px = (img, x, y) => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
function dot(img, cx, cy, r, c) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (Math.hypot(x - cx, y - cy) <= r) {
      const o = (y * img.width + x) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
    }
  }
}

test('ретушь убирает тёмную точку на ровном фоне', () => {
  const img = makeImage(80, 80, [120, 130, 140]);
  dot(img, 40, 40, 3, [10, 10, 10]);
  const res = healSpot(img, 40, 40, 5);
  assert.ok(res && !res.fallback);
  for (let y = 36; y <= 44; y++) for (let x = 36; x <= 44; x++) {
    const [r, g, b] = px(img, x, y);
    assert.ok(Math.abs(r - 120) <= 2 && Math.abs(g - 130) <= 2 && Math.abs(b - 140) <= 2, `${x},${y}: ${r},${g},${b}`);
  }
});

test('ретушь на градиенте подгоняет цвет под окружение', () => {
  const w = 120, h = 60;
  const img = makeImage(w, h, [0, 0, 0]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    img.data[o] = x * 2; img.data[o + 1] = 100; img.data[o + 2] = 255 - x * 2;
  }
  dot(img, 60, 30, 4, [255, 255, 0]);
  healSpot(img, 60, 30, 6);
  for (const x of [56, 60, 64]) {
    const [r, g, b] = px(img, x, 30);
    assert.ok(Math.abs(r - x * 2) <= 6, `красный в ${x}: ${r}`);
    assert.ok(Math.abs(g - 100) <= 3);
    assert.ok(Math.abs(b - (255 - x * 2)) <= 6);
  }
});

test('у края фото точка заливается цветом окружения', () => {
  const img = makeImage(30, 30, [200, 180, 160]);
  dot(img, 2, 2, 2, [0, 0, 0]);
  const res = healSpot(img, 2, 2, 4);
  assert.ok(res);
  const [r, g, b] = px(img, 2, 2);
  assert.ok(Math.abs(r - 200) <= 3 && Math.abs(g - 180) <= 3 && Math.abs(b - 160) <= 3, `${r},${g},${b}`);
});

test('точки ретуши масштабируются вместе с картинкой', () => {
  const img = makeImage(60, 60, [90, 90, 90]);
  dot(img, 30, 30, 2, [250, 250, 250]);
  healAll(img, [{ x: 60, y: 60, r: 8 }], 0.5);
  assert.ok(Math.abs(px(img, 30, 30)[0] - 90) <= 2);
});

test('фильтры: уникальные названия и сила 0 ничего не добавляет', () => {
  const ids = new Set(FILTERS.map((f) => f.id));
  assert.equal(ids.size, FILTERS.length);
  assert.ok(FILTERS.every((f) => f.name));
  const user = { ...DEFAULTS, exposure: 20 };
  const p = combineParams(user, 'cinema', 0);
  assert.equal(p.exposure, 20);
  assert.equal(p.contrast, 0);
  assert.equal(p.grade.amount, 0);
});

test('фильтр складывается с ползунками и не выходит за границы', () => {
  const p = combineParams({ ...DEFAULTS, contrast: 90 }, 'noir', 100);
  assert.equal(p.contrast, RANGE.contrast[1]);
  assert.equal(p.mono, 1);
  const half = combineParams(DEFAULTS, 'vivid', 50);
  assert.equal(half.vibrance, 20);
});

test('фильтр «Ч/Б» даёт серые пиксели, «Сепия» — тёплые', () => {
  const bw = makeImage(6, 6, [200, 80, 40]);
  applyAdjustments(bw, combineParams(DEFAULTS, 'bw'));
  const [r, g, b] = px(bw, 2, 2);
  assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1);
  const sep = makeImage(6, 6, [120, 120, 120]);
  applyAdjustments(sep, combineParams(DEFAULTS, 'sepia'));
  const [sr, , sb] = px(sep, 2, 2);
  assert.ok(sr > sb + 10, `${sr} > ${sb}`);
});
