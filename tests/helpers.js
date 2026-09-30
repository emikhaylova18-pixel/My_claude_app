// Рисует простую картинку в памяти: фон и прямоугольники заданных цветов.
export function makeImage(w, h, bg, rects = []) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = bg;
      for (const r of rects) {
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) c = r.c;
      }
      const o = (y * w + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
