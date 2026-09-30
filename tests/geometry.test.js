import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonArea, simplifyClosed, simplifyOpen, removeCollinear, pathD, pointInPolygon, bbox, translate, scaleAround, isCorner } from '../app/src/geometry.js';

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

test('площадь квадрата 10×10 равна 100', () => {
  assert.equal(Math.abs(polygonArea(square)), 100);
});

test('прямая линия упрощается до двух точек', () => {
  const line = Array.from({ length: 20 }, (_, i) => [i, 0]);
  assert.deepEqual(simplifyOpen(line, 0.5), [[0, 0], [19, 0]]);
});

test('лесенка по диагонали упрощается, а углы квадрата сохраняются', () => {
  const stairs = [];
  for (let i = 0; i < 10; i++) stairs.push([i, i], [i + 1, i]);
  const s = simplifyOpen(stairs, 1);
  assert.ok(s.length <= 3, 'осталось точек: ' + s.length);
  const sq = simplifyClosed([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]], 0.5);
  assert.equal(sq.length, 4);
  assert.equal(Math.abs(polygonArea(sq)), 100);
});

test('точки на одной прямой убираются', () => {
  const pts = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(removeCollinear(pts).length, 4);
});

test('путь SVG замкнут и в плавном, и в ломаном режиме', () => {
  assert.match(pathD(square, false), /^M0 0L10 0L10 10L0 10Z$/);
  const circle = Array.from({ length: 16 }, (_, i) => [10 * Math.cos(i * Math.PI / 8), 10 * Math.sin(i * Math.PI / 8)]);
  const d = pathD(circle, true);
  assert.ok(d.startsWith('M') && d.endsWith('Z') && d.includes('Q'), 'круг рисуется кривыми');
});

test('в плавном режиме острые углы квадрата остаются углами', () => {
  const d = pathD(square, true);
  assert.ok(!d.includes('Q'), d);
  assert.ok(isCorner([0, 0], [10, 0], [10, 10]));
  assert.ok(!isCorner([0, 0], [10, 0], [20, 1]));
});

test('точка внутри и снаружи многоугольника', () => {
  assert.equal(pointInPolygon([5, 5], square), true);
  assert.equal(pointInPolygon([15, 5], square), false);
});

test('габариты, сдвиг и масштаб', () => {
  assert.deepEqual(bbox(square), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(translate(square, 2, 3)[0], [2, 3]);
  assert.deepEqual(scaleAround(square, 2, 5, 5)[0], [-5, -5]);
});
