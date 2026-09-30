import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAMS, DEFAULTS, tone, buildLUTs, applyAdjustments, boxBlur, histogram, autoParams, isIdentity, noise,
} from '../app/src/photo/adjust.js';
import { makeImage } from './helpers.js';

const px = (img, x, y) => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const copy = (img) => ({ ...img, data: new Uint8ClampedArray(img.data) });
const gradient = (w, h) => {
  const img = makeImage(w, h, [0, 0, 0]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const v = Math.round((x / (w - 1)) * 255);
    img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v;
  }
  return img;
};

test('без правок картинка не меняется', () => {
  const img = gradient(32, 4);
  const before = new Uint8ClampedArray(img.data);
  applyAdjustments(img, {});
  assert.deepEqual(img.data, before);
  assert.ok(isIdentity(DEFAULTS));
});

test('каждый ползунок в крайних положениях не «переворачивает» тона', () => {
  for (const { key, min, max } of PARAMS) {
    if (['sharpen', 'clarity', 'vignette', 'grain', 'vibrance', 'saturation'].includes(key)) continue;
    for (const v of [min, max]) {
      const luts = buildLUTs({ ...DEFAULTS, [key]: v });
      for (const lut of luts) {
        for (let i = 1; i < 256; i++) {
          assert.ok(lut[i] >= lut[i - 1], `${key}=${v}: ${i - 1}→${lut[i - 1]}, ${i}→${lut[i]}`);
        }
      }
    }
  }
});

test('экспозиция: плюс светлее, минус темнее, белое не выбивается в пятно', () => {
  assert.ok(tone(0.5, { exposure: 50 }) > 0.6);
  assert.ok(tone(0.5, { exposure: -50 }) < 0.4);
  assert.equal(Math.round(tone(1, { exposure: 100 }) * 255), 255);
  assert.ok(tone(0.9, { exposure: 100 }) < 1, 'светлые мягко прижимаются, а не обрезаются');
});

test('контраст: тёмное темнее, светлое светлее, середина на месте', () => {
  const p = { contrast: 60 };
  assert.ok(tone(0.25, p) < 0.25);
  assert.ok(tone(0.75, p) > 0.75);
  assert.ok(Math.abs(tone(0.5, p) - 0.5) < 1e-9);
});

test('тени поднимают тёмное, светлые с минусом возвращают детали в небе', () => {
  assert.ok(tone(0.2, { shadows: 80 }) > 0.25);
  assert.ok(tone(0.85, { highlights: -80 }) < 0.8);
  assert.ok(tone(0.1, { highlights: -80 }) > 0.095, 'тёмное почти не трогается');
});

test('выцветание поднимает чёрную точку', () => {
  assert.ok(tone(0, { fade: 100 }) > 0.1);
  assert.ok(tone(1, { fade: 100 }) < 1);
});

test('насыщенность −100 делает фото чёрно-белым', () => {
  const img = makeImage(4, 4, [200, 60, 40]);
  applyAdjustments(img, { saturation: -100 });
  const [r, g, b] = px(img, 1, 1);
  assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1, `${r},${g},${b}`);
});

test('теплота добавляет красного и убирает синего', () => {
  const img = makeImage(4, 4, [128, 128, 128]);
  applyAdjustments(img, { temperature: 60 });
  const [r, , b] = px(img, 0, 0);
  assert.ok(r > 135 && b < 121, `${r} ${b}`);
});

test('сочность сильнее действует на блёклые цвета, чем на яркие', () => {
  const dull = makeImage(2, 2, [140, 120, 110]);
  const vivid = makeImage(2, 2, [230, 30, 30]);
  applyAdjustments(dull, { vibrance: 80 });
  applyAdjustments(vivid, { vibrance: 80 });
  const spread = (c) => Math.max(...c) - Math.min(...c);
  const gainDull = spread(px(dull, 0, 0)) / 30;
  const gainVivid = spread(px(vivid, 0, 0)) / 200;
  assert.ok(gainDull > gainVivid, `${gainDull} > ${gainVivid}`);
});

test('виньетка затемняет углы и не трогает центр', () => {
  const img = makeImage(60, 40, [180, 180, 180]);
  applyAdjustments(img, { vignette: 80 });
  assert.ok(px(img, 0, 0)[0] < 140);
  assert.ok(px(img, 30, 20)[0] >= 178);
});

test('размытие сохраняет ровный цвет и сглаживает ступеньку', () => {
  const w = 40, h = 3;
  const flat = new Float32Array(w * h).fill(100);
  const b = boxBlur(flat, w, h, 3);
  assert.ok(b.every((v) => Math.abs(v - 100) < 1e-4));
  const step = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 20; x < w; x++) step[y * w + x] = 255;
  const s = boxBlur(step, w, h, 2);
  assert.ok(s[w + 19] > 20 && s[w + 19] < 235);
  assert.ok(s[w + 2] < 1 && s[w + 37] > 254);
});

test('резкость усиливает перепад на границе', () => {
  const img = makeImage(30, 10, [80, 80, 80], [{ x: 15, y: 0, w: 15, h: 10, c: [170, 170, 170] }]);
  applyAdjustments(img, { sharpen: 100 }, { sharpenRadius: 1 });
  assert.ok(px(img, 14, 5)[0] < 80, 'тёмная сторона стала темнее');
  assert.ok(px(img, 15, 5)[0] > 170, 'светлая — светлее');
  assert.equal(px(img, 3, 5)[0], 80, 'вдали от края без изменений');
});

test('зерно одинаковое при каждой перерисовке и не меняет общую яркость', () => {
  const a = makeImage(50, 50, [128, 128, 128]);
  const b = copy(a);
  applyAdjustments(a, { grain: 80 });
  applyAdjustments(b, { grain: 80 });
  assert.deepEqual(a.data, b.data);
  const hist = histogram(a);
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist.l[i];
  assert.ok(Math.abs(sum / 2500 - 128) < 3);
  assert.ok(Math.abs(noise(3, 4)) <= 1);
});

test('гистограмма считает все пиксели', () => {
  const img = gradient(64, 2);
  const h = histogram(img);
  const total = h.l.reduce((s, v) => s + v, 0);
  assert.equal(total, 128);
});

test('«Авто» осветляет тёмное фото и темнит пересвеченное', () => {
  const dark = gradient(64, 8);
  for (let i = 0; i < dark.data.length; i += 4) {
    dark.data[i] *= 0.3; dark.data[i + 1] *= 0.3; dark.data[i + 2] *= 0.3;
  }
  assert.ok(autoParams(dark).exposure > 10);
  const bright = makeImage(40, 40, [235, 235, 235], [{ x: 0, y: 0, w: 10, h: 40, c: [120, 120, 120] }]);
  assert.ok(autoParams(bright).exposure < 0);
});

test('«Авто» убирает синий оттенок', () => {
  const blue = makeImage(40, 40, [90, 110, 170], [{ x: 0, y: 0, w: 20, h: 40, c: [150, 165, 220] }]);
  const p = autoParams(blue);
  assert.ok(p.temperature > 10, 'теплее: ' + p.temperature);
  const res = applyAdjustments(copy(blue), { temperature: p.temperature, tint: p.tint });
  const [r, , b] = px(res, 30, 10);
  assert.ok(b / r < 170 / 90, `синий перевес уменьшился: ${r}, ${b}`);
});
