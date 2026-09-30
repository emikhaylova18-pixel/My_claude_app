// Стартовый экран: показывает, есть ли незаконченная работа в каждом режиме.

import { projectToSVG } from './svg.js';

const $ = (id) => document.getElementById(id);

function read(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function showPreview(boxId, src, contain) {
  const img = new Image();
  img.alt = '';
  img.src = src;
  if (contain) img.className = 'contain';
  img.onload = () => {
    const box = $(boxId);
    box.innerHTML = '';
    box.append(img);
  };
}

const thumb = read('studio-raster-thumb');
if (thumb) {
  showPreview('photoArt', thumb, true);
  $('photoStatus').hidden = false;
}

try {
  const p = JSON.parse(read('vector-studio-project-v1') || 'null');
  if (p && Array.isArray(p.shapes) && p.shapes.length) {
    const svg = projectToSVG({ ...p, photo: null });
    showPreview('vectorArt', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), true);
    $('vectorStatus').hidden = false;
  }
} catch (e) { /* схемы нет — показываем картинку-заставку */ }
