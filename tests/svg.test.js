import test from 'node:test';
import assert from 'node:assert/strict';
import { projectToSVG } from '../app/src/svg.js';

const project = {
  width: 100, height: 50, background: '#fafafa', smooth: false,
  shapes: [
    { fill: '#ff0000', pts: [[0, 0], [10, 0], [10, 10]] },
    { fill: '#00ff00', pts: [[20, 20], [30, 20], [30, 30]], hidden: true },
  ],
};

test('SVG содержит размеры, фон и только видимые фигуры', () => {
  const svg = projectToSVG(project);
  assert.match(svg, /viewBox="0 0 100 50"/);
  assert.match(svg, /fill="#fafafa"/);
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.match(svg, /fill="#ff0000"/);
});

test('режим «схема» рисует только линии', () => {
  const svg = projectToSVG({ ...project, outline: true });
  assert.match(svg, /fill="none"/);
  assert.doesNotMatch(svg, /fill="#ff0000"/);
});
