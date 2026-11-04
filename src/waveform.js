// waveform.js
// The waveform strip at the bottom. It always shows the WHOLE recording, with a
// highlighted box marking the part you are currently looking at in the roll.
// Tap or drag on it to jump around a long recording.
//
//   computePeaks  - squeezes the audio into one (min, max) pair per pixel column
//   drawWaveform  - paints those pairs onto a <canvas>

import { colors } from "./theme.js";

/**
 * An audio file has MANY samples (44,100 per second!), but the screen only has
 * a few hundred pixel columns. For each column we look at the chunk of samples
 * that belongs to it and remember the lowest and highest value.
 *
 * @param {AudioBuffer} audioBuffer  decoded audio from the Web Audio API
 * @param {number} width             number of pixel columns to produce
 * @returns {Float32Array}           [min0, max0, min1, max1, ...]
 */
export function computePeaks(audioBuffer, width) {
  const samples = audioBuffer.getChannelData(0); // first channel is enough for the picture
  const samplesPerPixel = Math.max(1, Math.floor(samples.length / width));
  const peaks = new Float32Array(width * 2);

  for (let x = 0; x < width; x++) {
    const start = x * samplesPerPixel;
    let min = 1;
    let max = -1;

    for (let i = 0; i < samplesPerPixel && start + i < samples.length; i++) {
      const value = samples[start + i];
      if (value < min) min = value;
      if (value > max) max = value;
    }

    // If this column had no samples at all, draw a flat line.
    if (min > max) {
      min = 0;
      max = 0;
    }

    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }

  return peaks;
}

/**
 * Paint the waveform.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array|null} peaks   output of computePeaks (null = empty canvas)
 * @param {number|null} playhead      0 (start) to 1 (end), or null to hide the playhead
 * @param {{from:number, to:number}|null} visible
 *        the part of the recording visible in the roll, as fractions 0..1
 */
export function drawWaveform(canvas, peaks, playhead = null, visible = null) {
  const c = colors();
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;
  const dpr = canvas.clientWidth > 0 ? w / canvas.clientWidth : 1;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.waveBg;
  ctx.fillRect(0, 0, w, h);

  if (peaks) {
    // one vertical line per pixel column, from its min to its max
    ctx.strokeStyle = c.wave;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const columns = peaks.length / 2;
    for (let x = 0; x < columns; x++) {
      const yTop = mid - peaks[x * 2 + 1] * mid * 0.95;
      const yBottom = mid - peaks[x * 2] * mid * 0.95;
      ctx.moveTo(x + 0.5, yTop);
      ctx.lineTo(x + 0.5, Math.max(yBottom, yTop + 1)); // at least 1px tall
    }
    ctx.stroke();
  } else {
    ctx.strokeStyle = c.wave;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  // the box showing what the roll above is currently zoomed to
  if (visible) {
    const x1 = Math.round(visible.from * w);
    const x2 = Math.max(x1 + 3 * dpr, Math.round(visible.to * w));
    ctx.fillStyle = c.waveWindow;
    ctx.fillRect(x1, 0, x2 - x1, h);
    ctx.strokeStyle = c.waveWindowEdge;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(x1 + dpr, dpr, x2 - x1 - 2 * dpr, h - 2 * dpr);
  }

  // playhead
  if (playhead !== null) {
    const px = Math.round(playhead * w) + 0.5;
    ctx.strokeStyle = c.playhead;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
}
