// Generates the PNG app icons (no image libraries needed). Run: npm run icons
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const GREEN = [31, 77, 58];
const GOLD = [201, 162, 39];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges.
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / 16) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Distance from point to a line segment, for drawing round-capped strokes.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inCross(x, y, scale = 1) {
  const c = (v) => 0.5 + (v - 0.5) * scale;
  const w = (44 / 512 / 2) * scale;
  return segDist(x, y, c(256 / 512), c(104 / 512), c(256 / 512), c(408 / 512)) <= w
    || segDist(x, y, c(168 / 512), c(200 / 512), c(344 / 512), c(200 / 512)) <= w;
}

function appIcon(x, y) {
  if (inCross(x, y, 0.85)) return [...GOLD, 1];
  return [...GREEN, 1];
}

function badge(x, y) {
  return inCross(x, y, 1.2) ? [255, 255, 255, 1] : [0, 0, 0, 0];
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, appIcon));
fs.writeFileSync(path.join(out, 'badge-96.png'), png(96, badge));
console.log('Icons written to public/icons');
