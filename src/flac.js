// flac.js
// Writes a FLAC file: lossless compression, so the file is about half the size
// of a WAV but plays back EXACTLY the same.
//
// How FLAC makes the numbers smaller (explained simply):
//   1. The recording is cut into frames of 4096 samples.
//   2. In each frame we GUESS every sample from the ones just before it (the
//      simplest guesses: "same as last time", "a straight line", ...). Smooth
//      sound is easy to guess, so the guesses are close.
//   3. We only store the MISTAKES of the guess ("residuals"). They are small
//      numbers, and small numbers need fewer bits.
//   4. The mistakes are written with Rice coding: a short code for small numbers,
//      a longer one for big numbers.
//   5. For stereo, we also try storing (left + right) and (left - right), because
//      the two sides of a voice recording are usually almost the same.
//
// Format reference: https://xiph.org/flac/format.html

import { toInt } from "./wav.js";

const BLOCK_SIZE = 4096;
const MAX_ORDER = 4;          // the "guess" uses at most the previous 4 samples
const PARTITION_ORDER = 4;    // each frame is cut into up to 16 pieces with their own Rice setting
const MAX_RICE = 14;

// ---- checksums the format asks for ----
const crc8Table = new Uint8Array(256);
const crc16Table = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i, c16 = i << 8;
  for (let k = 0; k < 8; k++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 255 : (c8 << 1) & 255;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  crc8Table[i] = c8;
  crc16Table[i] = c16;
}
const crc8 = (bytes, length) => { let c = 0; for (let i = 0; i < length; i++) c = crc8Table[c ^ bytes[i]]; return c; };
const crc16 = (bytes, length) => { let c = 0; for (let i = 0; i < length; i++) c = ((c << 8) & 0xffff) ^ crc16Table[(c >> 8) ^ bytes[i]]; return c; };

/** Writes bits one after another (the format is not made of whole bytes). */
class BitWriter {
  constructor() {
    this.bytes = new Uint8Array(1 << 14);
    this.length = 0;   // whole bytes written
    this.current = 0;  // the byte being filled
    this.used = 0;     // bits in `current`
  }
  pushByte(b) {
    if (this.length === this.bytes.length) {
      const bigger = new Uint8Array(this.bytes.length * 2);
      bigger.set(this.bytes);
      this.bytes = bigger;
    }
    this.bytes[this.length++] = b;
  }
  /** Write `count` bits (0..32) of the non-negative whole number `value`. */
  write(value, count) {
    while (count > 0) {
      const take = Math.min(count, 8 - this.used);
      const shift = count - take;
      const part = Math.floor(value / 2 ** shift) % (1 << take); // the next `take` bits
      this.current = (this.current << take) | part;
      this.used += take;
      count -= take;
      if (this.used === 8) { this.pushByte(this.current); this.current = 0; this.used = 0; }
    }
  }
  /** Write a signed number in `count` bits (two's complement). */
  writeSigned(value, count) {
    this.write(value < 0 ? value + 2 ** count : value, count);
  }
  /** `zeros` zero bits followed by a one. */
  writeUnary(zeros) {
    while (zeros >= 24) { this.write(0, 24); zeros -= 24; }
    this.write(1, zeros + 1);
  }
  alignToByte() {
    if (this.used) this.write(0, 8 - this.used);
  }
}

// ---- guessing and Rice coding ----

/** The mistakes of the order-`order` guess for samples[from..]. (The first `order` samples are stored as they are.) */
function residuals(samples, order) {
  const n = samples.length;
  const r = new Float64Array(n - order);
  for (let i = order; i < n; i++) {
    const a = samples[i - 1], b = samples[i - 2], c = samples[i - 3], d = samples[i - 4];
    r[i - order] =
      order === 0 ? samples[i]
      : order === 1 ? samples[i] - a
      : order === 2 ? samples[i] - 2 * a + b
      : order === 3 ? samples[i] - 3 * a + 3 * b - c
      : samples[i] - 4 * a + 6 * b - 4 * c + d;
  }
  return r;
}

const zigzag = (v) => (v >= 0 ? 2 * v : -2 * v - 1); // signed -> 0,1,2,3... (small stays small)

/** The cheapest Rice setting for one piece of mistakes, and what it costs in bits. */
function bestRice(u, from, to) {
  const count = to - from;
  if (count <= 0) return { k: 0, bits: 0 };
  let sum = 0;
  for (let i = from; i < to; i++) sum += u[i];
  const guess = Math.max(0, Math.min(MAX_RICE, Math.floor(Math.log2(sum / count + 1))));
  let best = { k: 0, bits: Infinity };
  for (let k = Math.max(0, guess - 1); k <= Math.min(MAX_RICE, guess + 1); k++) {
    let bits = count * (k + 1);
    const divisor = 2 ** k;
    for (let i = from; i < to; i++) bits += Math.floor(u[i] / divisor);
    if (bits < best.bits) best = { k, bits };
  }
  return best;
}

/** Work out how to store one channel of one frame in the fewest bits. */
function planSubframe(samples, bits) {
  const n = samples.length;

  // all the same value (digital silence)?
  let same = true;
  for (let i = 1; i < n; i++) if (samples[i] !== samples[0]) { same = false; break; }
  if (same) return { kind: "constant", bits: 8 + bits };

  // which guess (order 0..4) makes the smallest mistakes? (judged quickly by their total size)
  let order = 0, bestSum = Infinity, bestResidual = null;
  for (let o = 0; o <= Math.min(MAX_ORDER, n - 1); o++) {
    const r = residuals(samples, o);
    let sum = 0;
    for (let i = 0; i < r.length; i++) sum += Math.abs(r[i]);
    if (sum < bestSum) { bestSum = sum; order = o; bestResidual = r; }
  }

  // how many pieces can the frame be cut into? (must divide evenly, and each piece needs more samples than `order`)
  let partitionOrder = PARTITION_ORDER;
  while (partitionOrder > 0 && (n % (1 << partitionOrder) !== 0 || (n >> partitionOrder) <= order)) partitionOrder--;
  const pieces = 1 << partitionOrder;
  const pieceSize = n >> partitionOrder;

  const u = Float64Array.from(bestResidual, zigzag);
  const params = [];
  let total = 8 + order * bits + 2 + 4; // subframe header + warm-up samples + coding method + partition order
  for (let p = 0; p < pieces; p++) {
    const from = p === 0 ? 0 : p * pieceSize - order;
    const to = (p + 1) * pieceSize - order;
    const rice = bestRice(u, from, to);
    params.push(rice.k);
    total += 4 + rice.bits;
  }

  const verbatim = 8 + n * bits;
  if (verbatim <= total) return { kind: "verbatim", bits: verbatim };
  return { kind: "fixed", order, partitionOrder, params, u, bits: total, estimate: bestSum };
}

function writeSubframe(w, plan, samples, bits) {
  w.write(0, 1); // padding bit
  if (plan.kind === "constant") {
    w.write(0, 6); w.write(0, 1);
    w.writeSigned(samples[0], bits);
  } else if (plan.kind === "verbatim") {
    w.write(1, 6); w.write(0, 1);
    for (const v of samples) w.writeSigned(v, bits);
  } else {
    w.write(8 + plan.order, 6); w.write(0, 1);
    for (let i = 0; i < plan.order; i++) w.writeSigned(samples[i], bits); // warm-up
    w.write(0, 2);                     // Rice coding
    w.write(plan.partitionOrder, 4);
    const pieces = 1 << plan.partitionOrder;
    const pieceSize = samples.length >> plan.partitionOrder;
    for (let p = 0; p < pieces; p++) {
      const k = plan.params[p];
      w.write(k, 4);
      const from = p === 0 ? 0 : p * pieceSize - plan.order;
      const to = (p + 1) * pieceSize - plan.order;
      const divisor = 2 ** k;
      for (let i = from; i < to; i++) {
        const value = plan.u[i];
        const quotient = Math.floor(value / divisor);
        w.writeUnary(quotient);
        if (k) w.write(value - quotient * divisor, k);
      }
    }
  }
}

/** A frame number in the format's own (UTF-8 style) way. */
function writeFrameNumber(w, number) {
  if (number < 0x80) { w.write(number, 8); return; }
  let extra = 1;
  while (number >= 2 ** (6 * extra + (6 - extra))) extra++; // how many continuation bytes
  const first = (0xff00 >> (extra + 1)) & 0xff;
  w.write(first | Math.floor(number / 2 ** (6 * extra)), 8);
  for (let i = extra - 1; i >= 0; i--) w.write(0x80 | (Math.floor(number / 2 ** (6 * i)) & 0x3f), 8);
}

/**
 * @param {Float32Array[]} channels  1 or 2 channels (more are cut down to 2)
 * @param {number} sampleRate
 * @param {16|24} bits
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Uint8Array>} the whole .flac file
 */
export async function encodeFlac(channels, sampleRate, bits = 16, onProgress) {
  channels = channels.slice(0, 2);
  const count = channels.length;
  const total = channels[0].length;
  const ints = channels.map((data) => Int32Array.from(data, (v) => toInt(v, bits)));

  const frames = [];
  let minFrame = Infinity, maxFrame = 0, minBlock = Infinity, maxBlock = 0;

  for (let start = 0, index = 0; start < total || (total === 0 && index === 0); start += BLOCK_SIZE, index++) {
    const size = Math.min(BLOCK_SIZE, total - start);
    const part = ints.map((data) => data.subarray(start, start + size));

    // what to store: left/right as they are, or a mix of them (stereo only)
    let signals = part.map((p) => ({ samples: p, bits }));
    let assignment = count - 1; // "independent channels"
    let plans = signals.map((s) => planSubframe(s.samples, s.bits));
    if (count === 2) {
      const left = part[0], right = part[1];
      const side = new Int32Array(size), mid = new Int32Array(size);
      for (let i = 0; i < size; i++) { side[i] = left[i] - right[i]; mid[i] = Math.floor((left[i] + right[i]) / 2); }
      const L = plans[0], R = plans[1];
      const S = planSubframe(side, bits + 1), M = planSubframe(mid, bits);
      const options = [
        { assignment: 1, signals: [{ samples: left, bits }, { samples: right, bits }], plans: [L, R], cost: L.bits + R.bits },
        { assignment: 8, signals: [{ samples: left, bits }, { samples: side, bits: bits + 1 }], plans: [L, S], cost: L.bits + S.bits },
        { assignment: 9, signals: [{ samples: side, bits: bits + 1 }, { samples: right, bits }], plans: [S, R], cost: S.bits + R.bits },
        { assignment: 10, signals: [{ samples: mid, bits }, { samples: side, bits: bits + 1 }], plans: [M, S], cost: M.bits + S.bits },
      ];
      const best = options.reduce((a, b) => (b.cost < a.cost ? b : a));
      assignment = best.assignment; signals = best.signals; plans = best.plans;
    }

    // ---- frame header ----
    const w = new BitWriter();
    w.write(0xfff8, 16);                                  // sync code, fixed block size
    w.write(size === BLOCK_SIZE ? 0b1100 : 0b0111, 4);    // block size: 4096, or "16-bit number follows"
    w.write(0, 4);                                        // sample rate: "see the file header"
    w.write(assignment, 4);                               // channel layout
    w.write(bits === 16 ? 0b100 : 0b110, 3);              // bits per sample
    w.write(0, 1);
    writeFrameNumber(w, index);
    if (size !== BLOCK_SIZE) w.write(size - 1, 16);
    w.write(crc8(w.bytes, w.length), 8);

    // ---- one subframe per channel ----
    signals.forEach((s, i) => writeSubframe(w, plans[i], s.samples, s.bits));
    w.alignToByte();
    w.write(crc16(w.bytes, w.length), 16);

    const bytes = w.bytes.subarray(0, w.length);
    frames.push(bytes);
    minFrame = Math.min(minFrame, bytes.length); maxFrame = Math.max(maxFrame, bytes.length);
    minBlock = Math.min(minBlock, size); maxBlock = Math.max(maxBlock, size);

    if (index % 40 === 0) {
      if (onProgress) onProgress(Math.min(1, (start + size) / Math.max(1, total)));
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the screen breathe
    }
    if (total === 0) break;
  }

  // ---- file header: "fLaC" + the STREAMINFO block ----
  const head = new BitWriter();
  for (const ch of "fLaC") head.write(ch.charCodeAt(0), 8);
  head.write(1, 1);          // this is the last metadata block
  head.write(0, 7);          // type 0 = STREAMINFO
  head.write(34, 24);        // its length
  head.write(minBlock === Infinity ? 0 : minBlock, 16);
  head.write(maxBlock, 16);
  head.write(minFrame === Infinity ? 0 : minFrame, 24);
  head.write(maxFrame, 24);
  head.write(sampleRate, 20);
  head.write(count - 1, 3);
  head.write(bits - 1, 5);
  head.write(Math.floor(total / 2 ** 32), 4);   // 36-bit sample count, in two pieces
  head.write(total % 2 ** 32, 32);
  for (let i = 0; i < 16; i++) head.write(0, 8); // MD5 checksum: 0 = "not calculated"

  let size = head.length;
  for (const f of frames) size += f.length;
  const file = new Uint8Array(size);
  file.set(head.bytes.subarray(0, head.length), 0);
  let at = head.length;
  for (const f of frames) { file.set(f, at); at += f.length; }
  if (onProgress) onProgress(1);
  return file;
}
