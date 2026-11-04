// yin.js
// The YIN pitch detection algorithm (de Cheveigne & Kawahara, 2002).
//
// The idea in one sentence: if a sound repeats every T samples, then the audio
// looks almost identical to a copy of itself shifted by T samples. YIN slides a
// copy of the audio along itself and finds the shift where the two match best.
// That shift is the period, and  frequency = sampleRate / period.
//
// Usage:
//   const yin = createYin({ sampleRate: 15000 });
//   const { freq, clarity } = yin.detect(samples, startIndex);
//   // freq is in Hz, or 0 if there is no clear pitch (silence, noise, "s" sounds)
//   // yin.frameLength tells you how many samples detect() reads from startIndex.

export function createYin({
  sampleRate,
  minFreq = 65,        // lowest pitch we look for (about C2)
  maxFreq = 1100,      // highest pitch we look for (about C6)
  windowSize = 512,    // how many samples we compare each time
  threshold = 0.2,     // lower = pickier. Try 0.1 (strict) to 0.3 (forgiving)
  silenceRms = 0.005,  // quieter than this (about -46 dB) counts as silence
}) {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq)); // shortest period
  const tauMax = Math.ceil(sampleRate / minFreq);               // longest period
  const d = new Float32Array(tauMax + 1);                       // scratch space

  const NO_PITCH = { freq: 0, clarity: 0 };

  function detect(x, start) {
    // 0. Skip silence. Without this, YIN would try to find a pitch in hiss.
    let energy = 0;
    for (let j = 0; j < windowSize; j++) {
      energy += x[start + j] * x[start + j];
    }
    if (Math.sqrt(energy / windowSize) < silenceRms) return NO_PITCH;

    // 1. Difference function: how different is the audio from a copy of
    //    itself shifted by `tau` samples? 0 = identical.
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < windowSize; j++) {
        const delta = x[start + j] - x[start + j + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }

    // 2. Cumulative mean normalisation. This is YIN's key trick: it rescales
    //    the numbers so that "a perfect match" is always near 0 and "no match"
    //    is near 1, no matter how loud the audio is.
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      d[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
    }

    // 3. Find the FIRST dip that goes below the threshold, then follow it down
    //    to its lowest point. (Taking the first dip, not the deepest one,
    //    avoids mistakes where we'd pick twice the real period.)
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < threshold) {
        while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) return NO_PITCH;

    // 4. Parabolic interpolation: the true period is usually between two whole
    //    samples. Fit a parabola through three points to estimate where the
    //    lowest point really is. This makes the result much more precise.
    const a = d[best - 1];
    const b = d[best];
    const c = d[best + 1];
    const denominator = a - 2 * b + c;
    const shift = denominator === 0 ? 0 : (0.5 * (a - c)) / denominator;
    const period = best + shift;

    return { freq: sampleRate / period, clarity: 1 - b };
  }

  return {
    detect,
    // detect() reads samples from `start` up to start + frameLength
    frameLength: windowSize + tauMax,
  };
}
