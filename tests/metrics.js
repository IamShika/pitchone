// tests/metrics.js
// Ways to MEASURE how good a shifted voice sounds, with numbers instead of ears.
//
//   periodicity()      how "clean and steady" the repeating wave is (1 = perfect).
//                      Glitches, clicks and a buzzy sound make this go down.
//   flutter()          how much the loudness jumps around from one 5 ms slice to the
//                      next. Bad grain joins make it jump.
//   spectrumDistance() how different the tone colour (formants) of two sounds is, in dB.

/** Plain FFT. Returns the magnitudes of the first size/2 bins. */
export function fftMagnitudes(data, from, size = 2048) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = (data[from + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < size; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const out = new Float64Array(size / 2);
  for (let b = 0; b < out.length; b++) out[b] = Math.hypot(re[b], im[b]);
  return out;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/**
 * How periodic the sound is, frame by frame: the best match between a 40 ms slice
 * and itself shifted by one period (1 = identical repeats, 0 = noise).
 * Looks only between `from` and `to` seconds.
 */
export function periodicity(data, sampleRate, from, to, minHz = 70, maxHz = 500) {
  const window = Math.round(0.04 * sampleRate);
  const hop = Math.round(0.01 * sampleRate);
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.ceil(sampleRate / minHz);
  const scores = [];
  for (let start = Math.round(from * sampleRate); start + window + maxLag < Math.round(to * sampleRate); start += hop) {
    let energy = 0;
    for (let i = 0; i < window; i++) energy += data[start + i] * data[start + i];
    if (energy < 1e-9) continue;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0, lagged = 0;
      for (let i = 0; i < window; i++) {
        cross += data[start + i] * data[start + i + lag];
        lagged += data[start + i + lag] * data[start + i + lag];
      }
      const r = cross / Math.sqrt(energy * lagged + 1e-12);
      if (r > best) best = r;
    }
    scores.push(best);
  }
  scores.sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { mean, worst: percentile(scores, 0.05) };
}

/** Average jump (in dB) in loudness between neighbouring 5 ms slices. Lower = smoother. */
export function flutter(data, sampleRate, from, to) {
  const size = Math.round(0.01 * sampleRate);
  const hop = Math.round(0.005 * sampleRate);
  const levels = [];
  for (let start = Math.round(from * sampleRate); start + size < Math.round(to * sampleRate); start += hop) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += data[start + i] * data[start + i];
    levels.push(10 * Math.log10(sum / size + 1e-12));
  }
  let total = 0;
  for (let i = 1; i < levels.length; i++) total += Math.abs(levels[i] - levels[i - 1]);
  return total / (levels.length - 1);
}

/** The long-term spectrum in dB (smoothed so single harmonics disappear). */
function smoothSpectrum(data, sampleRate, from, to, smoothHz = 250) {
  const size = 4096;
  const bins = size / 2;
  const sum = new Float64Array(bins);
  let frames = 0;
  for (let start = Math.round(from * sampleRate); start + size < Math.round(to * sampleRate); start += size / 2) {
    const m = fftMagnitudes(data, start, size);
    for (let b = 0; b < bins; b++) sum[b] += m[b] * m[b];
    frames++;
  }
  const hzPerBin = sampleRate / size;
  const radius = Math.max(1, Math.round(smoothHz / hzPerBin / 2));
  const out = [];
  for (let hz = 150; hz < 5000; hz += 50) {
    const centre = Math.round(hz / hzPerBin);
    let s = 0, n = 0;
    for (let b = Math.max(0, centre - radius); b <= centre + radius; b++) { s += sum[b]; n++; }
    out.push(10 * Math.log10(s / n / frames + 1e-12));
  }
  return out;
}

/**
 * How different the tone colour of two sounds is: the RMS difference (in dB) of
 * their smoothed spectra, after matching the overall loudness.
 */
export function spectrumDistance(a, b, sampleRate, from, to) {
  const sa = smoothSpectrum(a, sampleRate, from, to);
  const sb = smoothSpectrum(b, sampleRate, from, to);
  const offset = sa.reduce((s, v, i) => s + (v - sb[i]), 0) / sa.length;
  let total = 0;
  for (let i = 0; i < sa.length; i++) total += (sa[i] - sb[i] - offset) ** 2;
  return Math.sqrt(total / sa.length);
}

/** RMS level of a stretch of audio. */
export function rmsOf(data, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / (to - from));
}
