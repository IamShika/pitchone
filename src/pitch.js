// pitch.js
// Runs the YIN detector over a whole recording and returns the "pitch track":
// one pitch value every ~10 milliseconds.

import { createYin } from "./yin.js";

const TARGET_RATE = 15000; // we analyse at roughly this sample rate (faster on phones)
const HOP_SECONDS = 0.01;  // one pitch reading every 10 ms

/**
 * Make the audio mono and lower its sample rate by averaging groups of samples.
 * Voices have their pitch below ~1 kHz, so we don't need 44,100 samples/second.
 * That makes the analysis about 9x faster.
 *
 * `pad` zeros are added at the start and end so the first and last readings
 * have a full window of audio to look at.
 */
function downsample(audioBuffer, factor, pad) {
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const count = Math.floor(audioBuffer.length / factor);
  const out = new Float32Array(pad + count + pad); // starts filled with zeros

  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (const data of channels) {
      for (let k = 0; k < factor; k++) {
        sum += data[i * factor + k];
      }
    }
    out[pad + i] = sum / (factor * channels.length);
  }
  return out;
}

/**
 * Analyse a decoded recording.
 *
 * @param {AudioBuffer} audioBuffer
 * @param {object} [options]
 * @param {(fraction:number)=>void} [options.onProgress]  called with 0..1 while working
 * @param {()=>boolean} [options.isCancelled]             return true to stop early
 * @returns {Promise<null | {hop:number, freqs:Float32Array, clarity:Float32Array, level:Float32Array, duration:number}>}
 *   hop      seconds between readings (reading i belongs to time i * hop)
 *   freqs    pitch in Hz for each reading, 0 where there is no clear pitch
 *   clarity  0..1 how sure the detector is (1 = very sure)
 *   level    how loud each reading is (used to draw the blobs thicker where it is louder)
 */
export async function analyzePitch(audioBuffer, options = {}) {
  const { onProgress = () => {}, isCancelled = () => false } = options;

  const factor = Math.max(1, Math.round(audioBuffer.sampleRate / TARGET_RATE));
  const rate = audioBuffer.sampleRate / factor;

  const yin = createYin({ sampleRate: rate });
  const hop = Math.max(1, Math.round(rate * HOP_SECONDS));
  const pad = Math.ceil(yin.frameLength / 2);

  const x = downsample(audioBuffer, factor, pad);
  const samplesInRecording = x.length - 2 * pad;
  const frames = Math.floor(samplesInRecording / hop) + 1;

  const freqs = new Float32Array(frames);
  const clarity = new Float32Array(frames);
  const level = new Float32Array(frames); // loudness of each reading

  // A long recording takes a few seconds. Every ~30 ms we pause for a moment
  // so the page can update the progress text and stay responsive.
  let lastBreak = performance.now();
  for (let i = 0; i < frames; i++) {
    const result = yin.detect(x, i * hop);
    freqs[i] = result.freq;
    clarity[i] = result.clarity;
    level[i] = result.rms;

    if (i % 32 === 0 && performance.now() - lastBreak > 30) {
      onProgress(i / frames);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (isCancelled()) return null;
      lastBreak = performance.now();
    }
  }

  onProgress(1);
  return { hop: hop / rate, freqs, clarity, level, duration: audioBuffer.duration };
}

/** Index of the reading that belongs to time `seconds`. */
export function frameAt(track, seconds) {
  const i = Math.round(seconds / track.hop);
  return Math.min(Math.max(i, 0), track.freqs.length - 1);
}
