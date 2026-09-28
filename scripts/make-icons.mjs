// Generates PWA icons: green rounded square with a white QR-style motif.
// Zero dependencies — hand-rolled PNG encoder using node:zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(size, rgba) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundedRect(px, size, x0, y0, x1, y1, rad, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
      const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) {
        const i = (y * size + x) * 4;
        px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = color[3];
      }
    }
  }
}

function drawFinder(grid, n, gx, gy) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      grid[(gy + dy) * n + (gx + dx)] = edge || core ? 1 : 0;
    }
  }
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4); // transparent
  const green = [22, 163, 74, 255];
  const white = [255, 255, 255, 255];
  const dark = [17, 24, 39, 255];

  roundedRect(px, size, 0, 0, size, size, Math.round(size * 0.225), green);

  // White card
  const m = Math.round(size * 0.17);
  roundedRect(px, size, m, m, size - m, size - m, Math.round(size * 0.07), white);

  // QR-style modules inside the card
  const n = 15;
  const inner0 = m + Math.round(size * 0.055);
  const inner1 = size - m - Math.round(size * 0.055);
  const mod = (inner1 - inner0) / n;
  const grid = new Array(n * n).fill(0);
  const rnd = mulberry32(1234567);
  for (let i = 0; i < n * n; i++) grid[i] = rnd() < 0.42 ? 1 : 0;
  drawFinder(grid, n, 0, 0);
  drawFinder(grid, n, n - 7, 0);
  drawFinder(grid, n, 0, n - 7);

  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      if (!grid[gy * n + gx]) continue;
      const x0 = Math.round(inner0 + gx * mod);
      const y0 = Math.round(inner0 + gy * mod);
      const x1 = Math.round(inner0 + (gx + 1) * mod);
      const y1 = Math.round(inner0 + (gy + 1) * mod);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * size + x) * 4;
          px[i] = dark[0]; px[i + 1] = dark[1]; px[i + 2] = dark[2]; px[i + 3] = dark[3];
        }
      }
    }
  }
  return encodePNG(size, px);
}

for (const s of [192, 512]) {
  writeFileSync(join(outDir, `icon-${s}.png`), drawIcon(s));
  console.log(`wrote icon-${s}.png`);
}
