import { deflateSync, inflateSync } from 'node:zlib';

/**
 * =============================================================================
 * SCREENSHOT REDACTION
 * =============================================================================
 * Paints opaque rectangles over regions of a PNG.
 *
 * Written by hand rather than pulled from a library, and that needs a defence
 * because "do not reinvent" is usually right. Three reasons it is right here:
 *
 *   1. The realistic alternatives (sharp, jimp, canvas) are 10-60MB of native
 *      or transitive code to draw a filled rectangle. The brief penalises
 *      dependency breadth, and this is the clearest case of it in the project.
 *   2. Failure closed matters more than features. If this cannot understand an
 *      image it throws, and the caller's only options are to redact nothing or
 *      to write nothing — a decision we want in our own code, not buried in
 *      somebody's format-guessing heuristics.
 *   3. It is ~120 lines against a format we control the producer of: Playwright
 *      emits 8-bit non-interlaced PNGs, which is the exact subset supported.
 *
 * Region detection is NOT here. Regions come from accessibility bounding boxes
 * supplied by the driver — cheaper than OCR and exact for field-level data,
 * which is the only kind we can classify anyway. Stated as a limitation in
 * REPORT.md §6: text baked into an image is not found.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `[x, y, width, height]` in image pixels. */
export type Region = readonly [number, number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** Channels per pixel, by PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Paints `regions` black.
 *
 * Ancillary chunks (gAMA, pHYs, text) are dropped: they carry no pixels, and
 * preserving metadata on an image we are redacting is at best pointless and at
 * worst another channel for the data we just removed.
 */
export function blackOutRegions(png: Uint8Array, regions: readonly Region[]): Uint8Array {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG: signature mismatch');
  }
  if (regions.length === 0) return png;

  const { header, idat } = readChunks(buf);

  if (header.bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${header.bitDepth}; only 8 is handled`);
  }
  if (header.interlace !== 0) {
    throw new Error('unsupported interlaced PNG');
  }
  const channels = CHANNELS[header.colorType];
  if (channels === undefined) {
    throw new Error(
      `unsupported PNG colour type ${header.colorType}; ` +
        `palette images are not handled because redacting one means editing its palette`,
    );
  }

  const raw = unfilter(inflateSync(idat), header, channels);
  paint(raw, header, channels, regions);
  const refiltered = refilter(raw, header, channels);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(header.width, 0);
  ihdr.writeUInt32BE(header.height, 4);
  ihdr.writeUInt8(header.bitDepth, 8);
  ihdr.writeUInt8(header.colorType, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(refiltered, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function readChunks(buf: Buffer): { header: Header; idat: Buffer } {
  let offset = 8;
  let header: Header | null = null;
  const idatParts: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        interlace: data.readUInt8(12),
      };
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  if (!header) throw new Error('malformed PNG: no IHDR');
  if (idatParts.length === 0) throw new Error('malformed PNG: no IDAT');
  return { header, idat: Buffer.concat(idatParts) };
}

/** Reverse the per-scanline filters, producing a flat pixel buffer. */
function unfilter(data: Buffer, header: Header, channels: number): Buffer {
  const bpp = channels; // bit depth is 8, so one byte per channel
  const stride = header.width * bpp;
  const out = Buffer.alloc(stride * header.height);

  let pos = 0;
  for (let y = 0; y < header.height; y++) {
    const filter = data[pos++];
    if (filter === undefined) throw new Error('malformed PNG: truncated scanline');
    const rowStart = y * stride;
    const prevStart = rowStart - stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = data[pos++] ?? 0;
      const a = x >= bpp ? out[rowStart + x - bpp]! : 0;
      const b = y > 0 ? out[prevStart + x]! : 0;
      const c = x >= bpp && y > 0 ? out[prevStart + x - bpp]! : 0;

      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`malformed PNG: unknown scanline filter ${filter}`);
      }
      out[rowStart + x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Re-emit with filter 0 on every scanline.
 *
 * Filter selection is a compression optimisation; a redacted screenshot is
 * evidence, not a payload, and choosing the cheapest correct option keeps this
 * file short enough to review.
 */
function refilter(raw: Buffer, header: Header, channels: number): Buffer {
  const stride = header.width * channels;
  const out = Buffer.alloc((stride + 1) * header.height);
  for (let y = 0; y < header.height; y++) {
    out[y * (stride + 1)] = 0;
    raw.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return out;
}

function paint(raw: Buffer, header: Header, channels: number, regions: readonly Region[]): void {
  const stride = header.width * channels;
  /** Alpha is the last channel for colour types 4 and 6; leave it opaque. */
  const hasAlpha = header.colorType === 4 || header.colorType === 6;

  for (const [rx, ry, rw, rh] of regions) {
    const x0 = Math.max(0, Math.floor(rx));
    const y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(header.width, Math.ceil(rx + rw));
    const y1 = Math.min(header.height, Math.ceil(ry + rh));

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const at = y * stride + x * channels;
        for (let ch = 0; ch < channels; ch++) {
          raw[at + ch] = hasAlpha && ch === channels - 1 ? 0xff : 0x00;
        }
      }
    }
  }
}
