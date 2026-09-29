'use strict';

/* One-off generator for a simple, license-free placeholder app icon (a
   flat purple rounded square with a white confetti-dot motif — no text
   glyph rendering needed, no external artwork, nothing copyrighted). Run
   with `node build/generate-icon.js` to regenerate build/icon.png and
   build/icon.ico; the outputs are committed so electron-builder doesn't
   need this script (or a canvas/image dependency) at build time. */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x6c, 0x3f, 0xc7];   // brand purple, matches css/style.css's accent tones
const DOTS = [
  { x: 0.32, y: 0.34, r: 0.11, c: [0xff, 0xd1, 0x66] },   // yellow
  { x: 0.68, y: 0.30, r: 0.085, c: [0xff, 0xff, 0xff] }, // white
  { x: 0.62, y: 0.66, r: 0.13, c: [0x06, 0xd6, 0xa0] }, // teal
  { x: 0.30, y: 0.70, r: 0.075, c: [0xff, 0xff, 0xff] }, // white
];

function drawCanvas(size) {
  const px = new Uint8Array(size * size * 4);
  const corner = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-square mask
      const inCorner = (cx, cy) => (x - cx) ** 2 + (y - cy) ** 2 > corner * corner;
      let inside = true;
      if (x < corner && y < corner) inside = !inCorner(corner, corner);
      else if (x > size - corner && y < corner) inside = !inCorner(size - corner, corner);
      else if (x < corner && y > size - corner) inside = !inCorner(corner, size - corner);
      else if (x > size - corner && y > size - corner) inside = !inCorner(size - corner, size - corner);
      if (!inside) { px[i + 3] = 0; continue; }
      let [r, g, b] = BG;
      for (const d of DOTS) {
        const dx = x - d.x * size, dy = y - d.y * size;
        if (dx * dx + dy * dy <= (d.r * size) ** 2) { [r, g, b] = d.c; break; }
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

function downsample(src, srcSize, dstSize) {
  const dst = new Uint8Array(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.min(srcSize - 1, Math.floor((x + 0.5) * srcSize / dstSize));
      const sy = Math.min(srcSize - 1, Math.floor((y + 0.5) * srcSize / dstSize));
      const si = (sy * srcSize + sx) * 4, di = (y * dstSize + x) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(px, size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter type 0 per scanline
    px.copy ? null : null;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (1 + size * 4) + 1);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA, no interlace
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeIco(pngsBySize) {
  const sizes = Object.keys(pngsBySize).map(Number).sort((a, b) => a - b);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dirEntries = [], imageBufs = [];
  for (const size of sizes) {
    const png = pngsBySize[size];
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; entry[3] = 0;
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    imageBufs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...imageBufs]);
}

const full = drawCanvas(256);
const pngsBySize = {};
for (const size of [16, 32, 48, 64, 128, 256]) {
  const px = size === 256 ? full : downsample(full, 256, size);
  pngsBySize[size] = encodePng(px, size);
}

fs.writeFileSync(path.join(__dirname, 'icon.png'), pngsBySize[256]);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), encodeIco(pngsBySize));
console.log('Wrote build/icon.png and build/icon.ico');
