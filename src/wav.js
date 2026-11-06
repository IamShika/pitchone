// wav.js
// Writes a WAV file (the simplest audio file: a small header, then the raw samples).
//
// Samples inside the program are decimal numbers between -1 and 1. A file needs
// whole numbers, so they are scaled:
//   16-bit: -32768 .. 32767   (CD quality)
//   24-bit: -8388608 .. 8388607 (studio quality)
//   32-bit float: kept as they are (no rounding at all)

/**
 * @param {Float32Array[]} channels  one array per channel (all the same length)
 * @param {number} sampleRate
 * @param {16|24|32} bits  32 means 32-bit floating point
 * @returns {Uint8Array} the whole file
 */
export function encodeWav(channels, sampleRate, bits = 16) {
  const count = channels.length;
  const length = channels[0].length;
  const bytesPerSample = bits / 8;
  const dataBytes = length * count * bytesPerSample;
  const out = new DataView(new ArrayBuffer(44 + dataBytes));

  const text = (offset, s) => { for (let i = 0; i < s.length; i++) out.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, "RIFF");
  out.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, bits === 32 ? 3 : 1, true);   // 1 = whole numbers, 3 = floating point
  out.setUint16(22, count, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * count * bytesPerSample, true);
  out.setUint16(32, count * bytesPerSample, true);
  out.setUint16(34, bits, true);
  text(36, "data");
  out.setUint32(40, dataBytes, true);

  let at = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < count; c++) {
      const v = channels[c][i];
      if (bits === 32) {
        out.setFloat32(at, v, true);
      } else if (bits === 16) {
        out.setInt16(at, toInt(v, 16), true);
      } else {
        const n = toInt(v, 24);
        out.setUint8(at, n & 255);
        out.setUint8(at + 1, (n >> 8) & 255);
        out.setUint8(at + 2, (n >> 16) & 255);
      }
      at += bytesPerSample;
    }
  }
  return new Uint8Array(out.buffer);
}

/** A decimal sample (-1..1) as a whole number of the given size, clipped if too loud. */
export function toInt(v, bits) {
  const max = 2 ** (bits - 1);
  const n = Math.round(v * max);
  return n >= max ? max - 1 : n < -max ? -max : n;
}
