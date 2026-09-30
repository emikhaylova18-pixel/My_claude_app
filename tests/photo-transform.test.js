import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameMatrix, applyM, invert, mul, coverScale, orientedSize, outputSize,
  rotateGeom, flipGeom, fitAspect, dragCrop, aspectRatio, DEFAULT_GEOM, FULL,
} from '../app/src/photo/transform.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const nearPt = (p, q, eps = 1e-6) => near(p[0], q[0], eps) && near(p[1], q[1], eps);
const G = (over = {}) => ({ ...DEFAULT_GEOM, crop: { ...FULL }, ...over });

test('без правок кадр совпадает с исходником', () => {
  const m = frameMatrix(200, 100, G());
  assert.ok(nearPt(applyM(m, [0, 0]), [0, 0]));
  assert.ok(nearPt(applyM(m, [200, 100]), [200, 100]));
});

test('поворот на 90°: левый верхний угол уходит вправо вверх', () => {
  const m = frameMatrix(200, 100, G({ rot: 90 }));
  assert.deepEqual(orientedSize(200, 100, 90), [100, 200]);
  assert.ok(nearPt(applyM(m, [0, 0]), [100, 0]));
  assert.ok(nearPt(applyM(m, [200, 0]), [100, 200]));
});

test('обрезка сдвигает начало координат', () => {
  const m = frameMatrix(200, 100, G({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
  assert.ok(nearPt(applyM(m, [100, 0]), [0, 0]));
  assert.deepEqual(outputSize(200, 100, G({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } })), [100, 100]);
});

test('обратная матрица возвращает точку назад', () => {
  const m = frameMatrix(300, 200, G({ rot: 270, flip: true, angle: 12, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } }), 0.7);
  const p = [123, 45];
  assert.ok(nearPt(applyM(invert(m), applyM(m, p)), p, 1e-9));
  assert.ok(nearPt(applyM(mul(m, invert(m)), [5, 7]), [5, 7], 1e-9));
});

test('увеличение при наклоне закрывает углы', () => {
  assert.equal(coverScale(100, 100, 0), 1);
  assert.ok(near(coverScale(100, 100, 45), Math.SQRT2));
  const s = coverScale(300, 200, 10);
  const m = frameMatrix(300, 200, G({ angle: 10 }));
  // Все углы кадра должны попадать внутрь фото.
  const inv = invert(m);
  for (const c of [[0, 0], [300, 0], [0, 200], [300, 200]]) {
    const [x, y] = applyM(inv, c);
    assert.ok(x >= -1e-6 && x <= 300 + 1e-6 && y >= -1e-6 && y <= 200 + 1e-6, `угол ${c} → ${x},${y}, s=${s}`);
  }
});

test('кнопка «повернуть» поворачивает то, что видно, даже после отражения и наклона', () => {
  for (const g of [G(), G({ flip: true }), G({ angle: 7 }), G({ flip: true, angle: -9, rot: 90 })]) {
    const [fw, fh] = orientedSize(300, 200, g.rot);
    const a = frameMatrix(300, 200, g, 1, false);
    const b = frameMatrix(300, 200, rotateGeom(g), 1, false);
    for (const p of [[10, 20], [250, 180], [150, 100]]) {
      const [x, y] = applyM(a, p);
      assert.ok(nearPt(applyM(b, p), [fh - y, x], 1e-6), JSON.stringify(g));
    }
    assert.ok(fw > 0);
  }
});

test('кнопка «отразить» зеркалит то, что видно', () => {
  for (const g of [G(), G({ angle: 8 }), G({ rot: 90, angle: -5, flip: true })]) {
    const [fw] = orientedSize(300, 200, g.rot);
    const a = frameMatrix(300, 200, g, 1, false);
    const b = frameMatrix(300, 200, flipGeom(g), 1, false);
    const p = [40, 70];
    const [x, y] = applyM(a, p);
    assert.ok(nearPt(applyM(b, p), [fw - x, y], 1e-6));
  }
});

test('обрезка поворачивается вместе с кадром', () => {
  const g = G({ crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
  const a = frameMatrix(300, 200, g);
  const b = frameMatrix(300, 200, rotateGeom(g));
  // Одна и та же точка фото остаётся в той же части обрезки.
  const p = applyM(invert(a), [10, 10]);
  const [ow, oh] = outputSize(300, 200, g);
  const q = applyM(b, p);
  assert.ok(nearPt(q, [oh - 10, 10], 1e-6), `${q} при ${ow}×${oh}`);
});

test('соотношение сторон: рамка нужной формы внутри кадра', () => {
  const c = fitAspect({ ...FULL }, 1, 300, 200);
  assert.ok(near(c.w * 300, c.h * 200));
  assert.ok(near(c.h, 1));
  assert.ok(c.x >= 0 && c.x + c.w <= 1 + 1e-9);
  const tall = fitAspect({ ...FULL }, 9 / 16, 300, 200);
  assert.ok(near((tall.w * 300) / (tall.h * 200), 9 / 16));
  assert.ok(near(aspectRatio('orig', 300, 200, 90), 200 / 300));
});

test('перетаскивание угла с фиксированным соотношением', () => {
  const start = fitAspect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1, 400, 400);
  const c = dragCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 'se', 40, 10, 400, 400, 1);
  assert.ok(near(c.w, c.h), 'квадрат остаётся квадратом');
  assert.ok(near(c.x, 0.25) && near(c.y, 0.25), 'противоположный угол на месте');
  assert.ok(c.w > 0.5);
  const big = dragCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 'se', 900, 900, 400, 400, 1);
  assert.ok(big.x + big.w <= 1 + 1e-9 && big.y + big.h <= 1 + 1e-9, 'не выходит за кадр');
  assert.ok(start.w > 0);
});

test('свободное перетаскивание и сдвиг рамки не выходят за кадр', () => {
  const c = dragCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'nw', -500, -500, 300, 200);
  assert.ok(near(c.x, 0) && near(c.y, 0));
  const m = dragCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'move', 1000, 0, 300, 200);
  assert.ok(near(m.x + m.w, 1));
  const tiny = dragCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'e', -1000, 0, 300, 200);
  assert.ok(tiny.w * 300 >= 23.9, 'минимальный размер');
});
