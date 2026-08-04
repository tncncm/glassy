#!/usr/bin/env node
/**
 * Generates every PWA icon Glassy needs, purely from Node built-ins.
 *
 * No network, no image libraries, no downloaded art: a tiny hand-rolled PNG
 * encoder (zlib for the deflate step, everything else — chunking, CRC32,
 * scanline filtering — written out below) rasterises a few flat vector
 * shapes drawn directly into a pixel buffer.
 *
 * Run with: node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
mkdirSync(publicDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* Minimal PNG encoder (RGBA, 8-bit, no interlace)                     */
/* ------------------------------------------------------------------ */

/** @type {number[] | null} */
let crcTable = null;

function makeCrcTable() {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** @param {Buffer} buf */
function crc32(buf) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type four-char chunk type
 * @param {Buffer} data
 */
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode a raw RGBA pixel buffer (top-to-bottom, row-major, 4 bytes/px)
 * into a PNG file buffer.
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  // Raw scanlines: filter byte 0 (None) + width*4 bytes per row.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // no filter
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const compressed = deflateSync(raw, { level: 9 });
  const idat = pngChunk('IDAT', compressed);

  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Wrap a single PNG image in a minimal .ico container. Modern browsers and
 * OSes accept PNG-payload ICO frames directly (no BMP re-encoding needed).
 * @param {Buffer} pngBuf
 * @param {number} width
 * @param {number} height
 */
function encodeIco(pngBuf, width, height) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = width >= 256 ? 0 : width; // width (0 = 256)
  entry[1] = height >= 256 ? 0 : height; // height (0 = 256)
  entry[2] = 0; // color palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // data size
  entry.writeUInt32LE(header.length + entry.length, 12); // data offset

  return Buffer.concat([header, entry, pngBuf]);
}

/* ------------------------------------------------------------------ */
/* Tiny 2D pixel canvas + flat-vector shape helpers                    */
/* ------------------------------------------------------------------ */

class Canvas {
  /**
   * @param {number} size
   */
  constructor(size) {
    this.size = size;
    this.pixels = new Uint8Array(size * size * 4);
  }

  /** @param {[number, number, number, number]} rgba */
  fillAll(rgba) {
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = rgba[0];
      this.pixels[i + 1] = rgba[1];
      this.pixels[i + 2] = rgba[2];
      this.pixels[i + 3] = rgba[3];
    }
  }

  /**
   * Alpha-composite a single pixel (source-over) so soft edges/highlights
   * can be layered without clobbering what's underneath.
   * @param {number} x
   * @param {number} y
   * @param {[number, number, number, number]} rgba
   */
  blend(x, y, rgba) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    const srcA = rgba[3] / 255;
    if (srcA >= 1) {
      this.pixels[i] = rgba[0];
      this.pixels[i + 1] = rgba[1];
      this.pixels[i + 2] = rgba[2];
      this.pixels[i + 3] = 255;
      return;
    }
    const dstR = this.pixels[i];
    const dstG = this.pixels[i + 1];
    const dstB = this.pixels[i + 2];
    this.pixels[i] = Math.round(rgba[0] * srcA + dstR * (1 - srcA));
    this.pixels[i + 1] = Math.round(rgba[1] * srcA + dstG * (1 - srcA));
    this.pixels[i + 2] = Math.round(rgba[2] * srcA + dstB * (1 - srcA));
    this.pixels[i + 3] = 255;
  }

  toPng() {
    return encodePng(this.pixels, this.size, this.size);
  }
}

/**
 * Signed distance-ish containment test for an axis-aligned rounded rect.
 * @param {number} x
 * @param {number} y
 * @param {number} rx left
 * @param {number} ry top
 * @param {number} rw width
 * @param {number} rh height
 * @param {number} r corner radius
 */
function insideRoundedRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideCircle(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Point-in-triangle via barycentric sign test.
 * @param {number} px
 * @param {number} py
 */
function insideTriangle(px, py, x0, y0, x1, y1, x2, y2) {
  const d1 = sign(px, py, x0, y0, x1, y1);
  const d2 = sign(px, py, x1, y1, x2, y2);
  const d3 = sign(px, py, x2, y2, x0, y0);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

/* ------------------------------------------------------------------ */
/* Glassy icon design                                                  */
/*                                                                      */
/* Dark slate square, a glassy "car window" rounded rect with a         */
/* diagonal highlight streak, and a small bright runner glyph (head +   */
/* leaning torso + two stride legs) mid-stride on the sill.             */
/* ------------------------------------------------------------------ */

const COLORS = {
  background: [5, 6, 10, 255], // #05060a — matches manifest theme/background
  frame: [30, 41, 59, 255], // slate frame around the glass
  glass: [22, 74, 94, 255], // #164a5e-ish glassy teal
  glassHighlight: [255, 255, 255, 40], // soft diagonal streak, alpha-blended
  runner: [94, 234, 212, 255], // bright accent — #5eead4 (teal-green)
};

/**
 * @param {number} size final raster size in px
 * @param {boolean} maskable keep all content inside the maskable safe zone
 */
function drawIcon(size, maskable) {
  const canvas = new Canvas(size);
  canvas.fillAll(COLORS.background);

  // Content box: full-bleed for regular icons, shrunk to the maskable safe
  // zone (content must sit inside an 80%-diameter centered circle) for the
  // maskable variant.
  const contentFrac = maskable ? 0.55 : 0.82;
  const content = size * contentFrac;
  const ox = (size - content) / 2;
  const oy = (size - content) / 2;

  // Window frame (rounded rect, slightly inset).
  const frameR = content * 0.14;
  const frameX = ox;
  const frameY = oy + content * 0.06;
  const frameW = content;
  const frameH = content * 0.88;

  // Glass (inset further inside the frame).
  const glassInset = content * 0.07;
  const glassR = frameR * 0.7;
  const glassX = frameX + glassInset;
  const glassY = frameY + glassInset;
  const glassW = frameW - glassInset * 2;
  const glassH = frameH - glassInset * 2;

  // Runner glyph geometry, in absolute px, sitting on the glass "sill".
  const runnerScale = content * 0.34;
  const runnerCx = ox + content * 0.56;
  const runnerBaseY = glassY + glassH * 0.78;
  const headR = runnerScale * 0.16;
  const headCx = runnerCx;
  const headCy = runnerBaseY - runnerScale * 0.62;
  // Torso: a short leaning quad, approximated by a rotated rect via two
  // triangles for a forward-leaning "running" silhouette.
  const torsoTopX = headCx - runnerScale * 0.03;
  const torsoTopY = headCy + headR * 0.9;
  const torsoBotX = headCx + runnerScale * 0.1;
  const torsoBotY = runnerBaseY - runnerScale * 0.18;
  const torsoWidth = runnerScale * 0.16;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Frame.
      if (insideRoundedRect(x, y, frameX, frameY, frameW, frameH, frameR)) {
        canvas.blend(x, y, COLORS.frame);
      }
      // Glass.
      if (insideRoundedRect(x, y, glassX, glassY, glassW, glassH, glassR)) {
        canvas.blend(x, y, COLORS.glass);
      }
      // Diagonal glass highlight streak: a band where (x - y) falls in a
      // narrow range, clipped to the glass rect.
      if (insideRoundedRect(x, y, glassX, glassY, glassW, glassH, glassR)) {
        const diag = x - y;
        const bandCenter = glassX - glassY + glassW * 0.15;
        const bandWidth = glassW * 0.22;
        if (Math.abs(diag - bandCenter) < bandWidth) {
          canvas.blend(x, y, COLORS.glassHighlight);
        }
      }
      // Runner: head.
      if (insideCircle(x, y, headCx, headCy, headR)) {
        canvas.blend(x, y, COLORS.runner);
      }
      // Runner: leaning torso (quad split into two triangles).
      const tlx = torsoTopX - torsoWidth / 2;
      const trx = torsoTopX + torsoWidth / 2;
      const blx = torsoBotX - torsoWidth / 2;
      const brx = torsoBotX + torsoWidth / 2;
      if (
        insideTriangle(x, y, tlx, torsoTopY, trx, torsoTopY, brx, torsoBotY) ||
        insideTriangle(x, y, tlx, torsoTopY, brx, torsoBotY, blx, torsoBotY)
      ) {
        canvas.blend(x, y, COLORS.runner);
      }
      // Runner: back leg (trailing, angled up-back).
      if (
        insideTriangle(
          x,
          y,
          torsoBotX - torsoWidth * 0.3,
          torsoBotY,
          torsoBotX + torsoWidth * 0.2,
          torsoBotY,
          torsoBotX - runnerScale * 0.34,
          runnerBaseY,
        )
      ) {
        canvas.blend(x, y, COLORS.runner);
      }
      // Runner: front leg (leading, angled forward-down).
      if (
        insideTriangle(
          x,
          y,
          torsoBotX - torsoWidth * 0.1,
          torsoBotY,
          torsoBotX + torsoWidth * 0.4,
          torsoBotY,
          torsoBotX + runnerScale * 0.4,
          runnerBaseY + runnerScale * 0.06,
        )
      ) {
        canvas.blend(x, y, COLORS.runner);
      }
    }
  }

  return canvas;
}

/* ------------------------------------------------------------------ */
/* Emit files                                                          */
/* ------------------------------------------------------------------ */

/** @param {string} name @param {Buffer} buf */
function emit(name, buf) {
  writeFileSync(join(publicDir, name), buf);
  console.log(`wrote public/${name} (${buf.length} bytes)`);
}

const pwa192 = drawIcon(192, false);
emit('pwa-192x192.png', pwa192.toPng());

const pwa512 = drawIcon(512, false);
emit('pwa-512x512.png', pwa512.toPng());

const maskable512 = drawIcon(512, true);
emit('maskable-512x512.png', maskable512.toPng());

const apple180 = drawIcon(180, false);
emit('apple-touch-icon.png', apple180.toPng());

// favicon.ico: a small PNG-in-ICO wrapper so the browser's automatic
// /favicon.ico request never 404s, even with no <link rel="icon"> present.
const favSource = drawIcon(64, false);
emit('favicon.ico', encodeIco(favSource.toPng(), 64, 64));

// Hand-authored SVG favicon (crisp at any size, tiny, no rasterisation
// needed) mirroring the same window + runner motif.
const favSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#05060a"/>
  <rect x="8" y="10" width="48" height="40" rx="8" fill="#1e293b"/>
  <rect x="13" y="15" width="38" height="30" rx="5" fill="#164a5e"/>
  <path d="M13 15 L38 45" stroke="#ffffff" stroke-opacity="0.15" stroke-width="6"/>
  <circle cx="37" cy="24" r="4" fill="#5eead4"/>
  <path d="M35 28 L40 28 L38 37 L34 37 Z" fill="#5eead4"/>
  <path d="M34 37 L28 42 L30 43 L36 39 Z" fill="#5eead4"/>
  <path d="M38 37 L44 40 L42 42 L37 39 Z" fill="#5eead4"/>
</svg>
`;
writeFileSync(join(publicDir, 'favicon.svg'), favSvg);
console.log(`wrote public/favicon.svg (${favSvg.length} bytes)`);

console.log('\nicon generation complete.');
