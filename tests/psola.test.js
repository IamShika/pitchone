// tests/psola.test.js
// Run with:  node tests/psola.test.js
//
// Makes a fake vowel "sung" at a known pitch, shifts it with PSOLA, and then
// measures the result with our own pitch detector. We check that:
//   - the new pitch is what we asked for
//   - the sound is just as long and about as loud
//   - the voice keeps its tone colour (it does not turn into a chipmunk)
//   - Pitch Drift removal really flattens a drifting note
//   - untouched parts of the recording are left exactly as they were

import { analyzePitch } from "../src/pitch.js";
import { buildNotes } from "../src/segment.js";
import { renderEdited } from "../src/psola.js";
import { takeSnapshot, correctPitch } from "../src/correct.js";
import { midiToFreq, freqToMidi } from "../src/notes.js";
import { check, finish } from "./check.js";

const SR = 44100;

/**
 * A vowel-like voice: harmonics of the pitch, strongest near a "formant" at
 * 800 Hz (that peak is what gives a vowel its colour, and it must NOT move
 * when we change the pitch).
 */
function makeVowel(seconds, freqAt, formantHz = 800) {
  const out = new Float32Array(Math.round(seconds * SR));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = freqAt(i / SR);
    phase += (2 * Math.PI * f) / SR;
    let v = 0;
    for (let k = 1; k * f < 5000; k++) {
      const distance = (k * f - formantHz) / 300;
      v += Math.sin(k * phase) * (0.15 / k + Math.exp(-distance * distance));
    }
    const t = i / SR;
    out[i] = v * 0.12 * Math.min(1, t / 0.03, (seconds - t) / 0.03);
  }
  return out;
}

const fakeBuffer = (data, rate = SR) => ({ sampleRate: rate, length: data.length, numberOfChannels: 1, duration: data.length / rate, getChannelData: () => data });

async function analyse(data) {
  const track = await analyzePitch(fakeBuffer(data));
  return { track, ...buildNotes(track) };
}

/** Median pitch (as a note number) of a recording, ignoring the edges. */
async function medianMidi(data) {
  const track = await analyzePitch(fakeBuffer(data));
  const values = Array.from(track.freqs).filter((f) => f > 0).map(freqToMidi).sort((a, b) => a - b);
  return values[values.length >> 1];
}

const rms = (data, from = 0, to = data.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / (to - from));
};

/** Plain FFT magnitude, so we can measure where the energy of a sound sits. */
function spectralCentroid(data, from, size = 8192) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = (data[from + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  for (let i = 1, j = 0; i < size; i++) { // bit reversal
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < size; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  let weighted = 0;
  let total = 0;
  for (let b = 1; b < size / 2; b++) {
    const hz = (b * SR) / size;
    if (hz > 4000) break;
    const magnitude = Math.hypot(re[b], im[b]);
    weighted += hz * magnitude;
    total += magnitude;
  }
  return weighted / total;
}

// ---- 1. the new pitch is the one we asked for ----
for (const [hz, shift] of [[150, 3], [150, -4], [220, 7], [220, -7], [330, 2], [110, 12], [260, -12]]) {
  const voice = makeVowel(1.2, () => hz);
  const { track, notes } = await analyse(voice);
  notes.forEach((n) => (n.targetCenter += shift));
  const [shifted] = renderEdited([voice], SR, notes, track.hop);
  const expected = freqToMidi(hz) + shift;
  const got = await medianMidi(shifted);
  const cents = (got - expected) * 100;
  check(
    hz + " Hz voice shifted " + (shift > 0 ? "+" : "") + shift + " semitones",
    notes.length === 1 && Math.abs(cents) < 20,
    "off by " + cents.toFixed(1) + " cents"
  );
}

// ---- 2. length, loudness ----
{
  const voice = makeVowel(1.5, () => 200);
  const { track, notes } = await analyse(voice);
  notes[0].targetCenter += 5;
  const [shifted] = renderEdited([voice], SR, notes, track.hop);
  const middle = [Math.round(0.3 * SR), Math.round(1.2 * SR)];
  const db = 20 * Math.log10(rms(shifted, ...middle) / rms(voice, ...middle));
  check("the shifted sound is exactly as long as the original", shifted.length === voice.length);
  check("and about as loud (within 2 dB)", Math.abs(db) < 2, db.toFixed(2) + " dB");
}

// ---- 3. voice character is kept (formants do not move) ----
{
  const voice = makeVowel(1.5, () => 150);
  const { track, notes } = await analyse(voice);
  notes[0].targetCenter += 7; // a fifth up: a "tape speed-up" would make the tone 1.5x brighter
  const [shifted] = renderEdited([voice], SR, notes, track.hop);
  const before = spectralCentroid(voice, Math.round(0.5 * SR));
  const after = spectralCentroid(shifted, Math.round(0.5 * SR));
  check("tone colour stays put when the pitch goes up a fifth (no chipmunk)", after / before > 0.85 && after / before < 1.2, "brightness x" + (after / before).toFixed(2) + " (a tape speed-up would give x1.50)");
}

// ---- 4. vibrato survives the shift ----
{
  const freqAt = (t) => 220 * Math.pow(2, (0.5 * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
  const voice = makeVowel(2, freqAt);
  const { track, notes } = await analyse(voice);
  notes.forEach((n) => (n.targetCenter += 4));
  const [shifted] = renderEdited([voice], SR, notes, track.hop);
  const out = await analyzePitch(fakeBuffer(shifted));
  const mids = Array.from(out.freqs.slice(20, -20)).filter((f) => f > 0).map(freqToMidi);
  const swing = Math.max(...mids) - Math.min(...mids);
  const centre = mids.reduce((a, b) => a + b, 0) / mids.length;
  check("vibrato is kept (about 1 semitone wide)", swing > 0.7 && swing < 1.4, swing.toFixed(2) + " semitones");
  check("...and now centred 4 semitones higher", Math.abs(centre - (freqToMidi(220) + 4)) < 0.1, centre.toFixed(2));
}

// ---- 5. Pitch Drift: a note that creeps up gets straightened ----
{
  const freqAt = (t) => 200 * Math.pow(2, (0.4 * (t / 1.6)) / 12); // creeps up 0.4 semitones in 1.6 s (a bigger creep would be cut into two notes)
  const voice = makeVowel(1.6, freqAt);
  const slope = async (data) => {
    const t = await analyzePitch(fakeBuffer(data));
    const y = Array.from(t.freqs.slice(20, -20)).filter((f) => f > 0).map(freqToMidi);
    const n = y.length, mx = (n - 1) / 2, my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    y.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
    return (num / den) * 100; // semitones per second
  };
  const { track, notes } = await analyse(voice);
  check("a gently creeping note is still ONE note", notes.length === 1, notes.length + " notes");
  const before = await slope(voice);
  correctPitch(notes, [0], takeSnapshot(notes), { centerAmount: 0, driftAmount: 1, snap: false });
  const [straightened] = renderEdited([voice], SR, notes, track.hop);
  const after = await slope(straightened);
  check("Pitch Drift 100% removes the creep from the actual sound", Math.abs(after) < Math.abs(before) * 0.3, before.toFixed(2) + " -> " + after.toFixed(2) + " semitones/s");
}

// ---- 6. a whole phrase: edited notes move, everything else is untouched ----
{
  // three notes with silence between them
  const parts = [[60, 0.5], [64, 0.5], [67, 0.5]];
  const samples = [];
  const starts = [];
  for (const [midi, seconds] of parts) {
    samples.push(...new Float32Array(Math.round(0.15 * SR)));
    starts.push(samples.length);
    samples.push(...makeVowel(seconds, () => midiToFreq(midi)));
  }
  samples.push(...new Float32Array(Math.round(0.15 * SR)));
  const data = Float32Array.from(samples);
  const { track, notes } = await analyse(data);
  check("three notes found in the phrase", notes.length === 3);

  notes[1].targetCenter -= 2; // lower only the middle note by a whole tone
  const [out] = renderEdited([data], SR, notes, track.hop);

  const same = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== data[i]) return false; return true; };
  check("the first note is bit-for-bit untouched", same(0, Math.round(starts[0] + 0.45 * SR)));
  check("the last note is bit-for-bit untouched", same(Math.round(starts[2] + 0.05 * SR), data.length));

  const middle = out.slice(starts[1] + Math.round(0.1 * SR), starts[1] + Math.round(0.4 * SR));
  const got = await medianMidi(middle);
  check("the middle note moved down a whole tone (E4 -> D4)", Math.abs(got - 62) < 0.2, "now " + got.toFixed(2));

  const seam = (i) => Math.abs(out[i] - out[i - 1]);
  let biggestJump = 0;
  for (let i = starts[1] - 800; i < starts[1] + 800; i++) biggestJump = Math.max(biggestJump, seam(i));
  check("no clicks where the edited note starts", biggestJump < 0.2, "biggest sample-to-sample step " + biggestJump.toFixed(3));
}

// ---- 7. stereo: both channels are shifted the same way ----
{
  const voice = makeVowel(1.2, () => 180);
  const quiet = Float32Array.from(voice, (v) => v * 0.5);
  const { track, notes } = await analyse(voice);
  notes[0].targetCenter += 3;
  const [left, right] = renderEdited([voice, quiet], SR, notes, track.hop);
  const ratio = rms(right, 20000, 40000) / rms(left, 20000, 40000);
  check("stereo: the quieter channel stays half as loud", Math.abs(ratio - 0.5) < 0.02, "ratio " + ratio.toFixed(3));
}

// ---- 8. speed: a 3 minute recording ----
{
  const note = makeVowel(180, () => 200); // 3 minutes of one long "note"
  const { track, notes } = await analyse(note);
  notes.forEach((n) => (n.targetCenter += 2));
  const started = performance.now();
  renderEdited([note], SR, notes, track.hop);
  const seconds = (performance.now() - started) / 1000;
  check("rendering 3 minutes takes only a few seconds", seconds < 10, seconds.toFixed(1) + " s");
}

finish();
