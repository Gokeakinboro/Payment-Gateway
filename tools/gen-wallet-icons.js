#!/usr/bin/env node
/* Generates Paylode Wallet PWA icons (pure Node, no native deps).
   Navy #1a2744 background, lime #7dc534 wallet mark. 4x supersampled for smooth edges.
   Outputs: icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png (180), favicon-32.png */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const NAVY = [0x1a, 0x27, 0x44];
const LIME = [0x7d, 0xc5, 0x34];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// rounded-rect signed coverage at point (px,py) in [0,1] space; returns 1 inside, 0 outside
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const dx = px - cx, dy = py - cy;
  return (dx * dx + dy * dy) <= r * r;
}
function inCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy; return dx * dx + dy * dy <= r * r;
}

// draw one logical pixel (returns [r,g,b]) at u,v in [0,1]; maskable=full bleed bg
function sample(u, v, maskable) {
  // background
  let col = maskable ? NAVY : null;
  if (!maskable) {
    col = inRoundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.22) ? NAVY : WHITE; // white = transparent later
  }
  // safe zone: shrink mark for maskable
  const s = maskable ? 0.80 : 1.0, o = (1 - s) / 2;
  const U = (u - o) / s, V = (v - o) / s;
  // wallet body (lime rounded rect)
  if (inRoundRect(U, V, 0.20, 0.30, 0.80, 0.72, 0.07)) col = LIME;
  // top slot line (navy) inside body
  if (inRoundRect(U, V, 0.20, 0.30, 0.80, 0.385, 0.07) && V > 0.355) col = NAVY;
  // clasp button (navy circle on right)
  if (inCircle(U, V, 0.705, 0.55, 0.052)) col = NAVY;
  // inner lime dot in clasp
  if (inCircle(U, V, 0.705, 0.55, 0.022)) col = LIME;
  return col;
}

function render(size, maskable) {
  const SS = 4, W = size * SS;
  const acc = new Float32Array(size * size * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, v = (y + 0.5) / W;
      const c = sample(u, v, maskable);
      const tx = Math.floor(x / SS), ty = Math.floor(y / SS), i = (ty * size + tx) * 4;
      if (c === WHITE) { acc[i + 3] += 0; } // transparent
      else { acc[i] += c[0]; acc[i + 1] += c[1]; acc[i + 2] += c[2]; acc[i + 3] += 255; }
    }
  }
  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let p = 0; p < size * size; p++) {
    const a = acc[p * 4 + 3] / n;
    if (a < 1) { out[p * 4 + 3] = 0; continue; }
    out[p * 4] = Math.round(acc[p * 4] / (a / 255 * n));
    out[p * 4 + 1] = Math.round(acc[p * 4 + 1] / (a / 255 * n));
    out[p * 4 + 2] = Math.round(acc[p * 4 + 2] / (a / 255 * n));
    out[p * 4 + 3] = Math.round(a);
  }
  return encodePNG(size, size, out);
}

const root = path.join(__dirname, '..');
const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true], // iOS clips corners itself; full-bleed navy looks best
  ['favicon-32.png', 32, false],
];
for (const [name, size, mask] of jobs) {
  fs.writeFileSync(path.join(root, name), render(size, mask));
  console.log('wrote', name, size + 'px', mask ? '(maskable)' : '');
}
