// tests/voice.js
// Makes a fake but REALISTIC singing voice, so we can test the pitch shifter on
// something much closer to a real recording than a plain sum of sine waves.
//
// A real voice has two parts:
//   1. The SOURCE: the vocal cords open and close once per period, making a
//      buzzy pulse train. No two pulses are exactly alike (the period wobbles a
//      little = "jitter", the loudness wobbles a little = "shimmer") and some
//      breath noise leaks through.
//   2. The FILTER: the throat and mouth shape the buzz. They boost certain
//      frequencies, called "formants". The formants are what makes an "ah"
//      sound different from an "ee". They must NOT move when we change the pitch.
//
// We copy exactly that: pulse train -> a few resonant filters (one per formant).

/** A small seeded random number generator, so every test run is identical. */
export function makeRandom(seed = 1) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // a bell-curve random number (Box-Muller)
  const gauss = () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gauss };
}

/** Formants (centre Hz, bandwidth Hz) of a few vowels. */
export const VOWELS = {
  ah: [[700, 90], [1150, 100], [2600, 140], [3500, 180]],
  ee: [[300, 60], [2300, 110], [3000, 150], [3700, 200]],
  oo: [[330, 70], [800, 90], [2500, 140], [3400, 180]],
};

/** One resonant filter (a "formant"). */
function resonator(centreHz, bandwidthHz, sampleRate) {
  const r = Math.exp((-Math.PI * bandwidthHz) / sampleRate);
  const a1 = -2 * r * Math.cos((2 * Math.PI * centreHz) / sampleRate);
  const a2 = r * r;
  const gain = 1 - r; // keeps the level sensible
  let y1 = 0, y2 = 0;
  return (x) => {
    const y = gain * x - a1 * y1 - a2 * y2;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** The shape of one vocal-cord pulse (phase 0..1) -> airflow speed. */
function glottalFlow(phase) {
  const open = 0.42; // fraction of the period the cords are opening
  const close = 0.16; // ... and closing
  if (phase < open) return 0.5 * (1 - Math.cos((Math.PI * phase) / open));
  if (phase < open + close) return Math.cos((Math.PI * (phase - open)) / (2 * close));
  return 0;
}

/**
 * @param {object} o
 * @param {number} o.seconds
 * @param {(t:number)=>number} o.freqAt   the sung pitch (Hz) at time t
 * @param {number} [o.sampleRate=44100]
 * @param {string} [o.vowel="ah"]
 * @param {number} [o.jitter=0.006]      period-to-period wobble (0.006 = 0.6 %)
 * @param {number} [o.shimmer=0.04]      loudness wobble per period
 * @param {number} [o.breath=0.06]       breath noise (0 = none)
 * @param {number} [o.seed=1]
 * @returns {Float32Array}
 */
export function makeVoice({ seconds, freqAt, sampleRate = 44100, vowel = "ah", jitter = 0.006, shimmer = 0.04, breath = 0.06, seed = 1 }) {
  const random = makeRandom(seed);
  const total = Math.round(seconds * sampleRate);
  const filters = VOWELS[vowel].map(([hz, bw]) => resonator(hz, bw, sampleRate));
  const out = new Float32Array(total);

  let phase = 0;
  let periodScale = 1 + jitter * random.gauss();
  let loudness = 1 + shimmer * random.gauss();
  let lastFlow = 0;
  let lowpass = 0;

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    phase += (1 / sampleRate) * freqAt(t) / periodScale;
    if (phase >= 1) { // a new vocal-cord cycle starts
      phase -= 1;
      periodScale = Math.max(0.9, 1 + jitter * random.gauss());
      loudness = Math.max(0.5, 1 + shimmer * random.gauss());
    }
    const flow = glottalFlow(phase) * loudness;
    const slope = (flow - lastFlow) * sampleRate / 3000; // airflow slope = what the mouth radiates
    lastFlow = flow;

    // breath noise is strongest while the cords are open
    lowpass += 0.5 * (random.gauss() - lowpass);
    const noise = lowpass * breath * (0.3 + 0.7 * glottalFlow(phase));

    let v = slope + noise;
    for (const f of filters) v = f(v);
    out[i] = v;
  }

  // gentle fade in / out, and a sensible overall level (about -20 dB)
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  const fade = Math.round(0.03 * sampleRate);
  for (let i = 0; i < total; i++) out[i] *= (0.3 / peak) * Math.min(1, i / fade, (total - 1 - i) / fade);
  return out;
}

/** A vibrato-and-drift pitch contour, like a real singer's long note. */
export function singerPitch(centreHz, { vibratoHz = 5.5, vibratoSemitones = 0.35, driftSemitones = 0.15, seconds = 2 } = {}) {
  return (t) => {
    const semitones = vibratoSemitones * Math.sin(2 * Math.PI * vibratoHz * t) + driftSemitones * (t / seconds);
    return centreHz * Math.pow(2, semitones / 12);
  };
}
