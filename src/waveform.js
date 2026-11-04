// waveform.js
// Two small functions:
//   computePeaks  - squeezes the audio into one (min, max) pair per pixel column
//   drawWaveform  - paints those pairs onto a <canvas>

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
  const samples = audioBuffer.getChannelData(0); // first channel is enough for now
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
 * Paint the waveform. `playhead` is a number from 0 (start) to 1 (end),
 * or null to hide the playhead line.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array|null} peaks   output of computePeaks (null = empty canvas)
 * @param {number|null} playhead
 */
export function drawWaveform(canvas, peaks, playhead = null) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;

  ctx.clearRect(0, 0, w, h);

  // center line
  ctx.strokeStyle = "#3a3f50";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  if (!peaks) return;

  // one vertical line per pixel column, from its min to its max
  ctx.strokeStyle = "#6c8cff";
  ctx.beginPath();
  const columns = peaks.length / 2;
  for (let x = 0; x < columns; x++) {
    const yTop = mid - peaks[x * 2 + 1] * mid;
    const yBottom = mid - peaks[x * 2] * mid;
    ctx.moveTo(x + 0.5, yTop);
    ctx.lineTo(x + 0.5, Math.max(yBottom, yTop + 1)); // at least 1px tall
  }
  ctx.stroke();

  // playhead
  if (playhead !== null) {
    const px = Math.round(playhead * w) + 0.5;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
}
