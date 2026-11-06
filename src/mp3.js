// mp3.js
// Writes an MP3 file with the LAME encoder (vendor/lamejs.js, a JavaScript port).
// MP3 throws away sound that is hard to hear, so the file is small (about 1 MB per
// minute at 128 kbps) but not identical to the original.
//
// The encoder is big (250 KB), so it is only loaded when you really export an MP3.

import { toInt } from "./wav.js";

const CHUNK = 1152 * 8; // samples per round (MP3 works in blocks of 1152)

/**
 * @param {Float32Array[]} channels  1 or 2 channels (more are cut down to 2)
 * @param {number} sampleRate
 * @param {number} kbps   bit rate: 96, 128, 192, 256 or 320
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function encodeMp3(channels, sampleRate, kbps = 192, onProgress) {
  const { Mp3Encoder } = await import("../vendor/lamejs.js");
  channels = channels.slice(0, 2);
  const encoder = new Mp3Encoder(channels.length, sampleRate, kbps);
  const total = channels[0].length;
  const parts = [];
  let size = 0;

  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(total, start + CHUNK);
    const pieces = channels.map((data) => {
      const out = new Int16Array(end - start);
      for (let i = start; i < end; i++) out[i - start] = toInt(data[i], 16);
      return out;
    });
    const encoded = channels.length === 1 ? encoder.encodeBuffer(pieces[0]) : encoder.encodeBuffer(pieces[0], pieces[1]);
    if (encoded.length) { parts.push(encoded); size += encoded.length; }
    if (((start / CHUNK) | 0) % 25 === 0) {
      if (onProgress) onProgress(end / total);
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the screen breathe
    }
  }
  const last = encoder.flush();
  if (last.length) { parts.push(last); size += last.length; }

  const file = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { file.set(p, at); at += p.length; }
  if (onProgress) onProgress(1);
  return file;
}
