// tests/yin.test.js
// Run with:  node tests/yin.test.js     (or: npm test)
//
// We can't ask a real singer to hold a perfect note, so we make fake "voices"
// with maths and check that the pitch detector finds the right note.

import { analyzePitch } from "../src/pitch.js";
import { freqToMidi } from "../src/notes.js";

const SAMPLE_RATE = 44100;
let failures = 0;

function check(name, ok, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}

/** Pretend to be a browser AudioBuffer. */
function fakeBuffer(samples) {
  return {
    sampleRate: SAMPLE_RATE,
    length: samples.length,
    numberOfChannels: 1,
    duration: samples.length / SAMPLE_RATE,
    getChannelData: () => samples,
  };
}

/**
 * A voice-like tone: a fundamental plus overtones that get quieter.
 * `freqAt(t)` says what the pitch is at time t, so we can make glides and vibrato.
 */
function makeVoice(seconds, freqAt, harmonics = 8) {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    phase += (2 * Math.PI * freqAt(i / SAMPLE_RATE)) / SAMPLE_RATE;
    let v = 0;
    for (let k = 1; k <= harmonics; k++) v += Math.sin(k * phase) / k;
    out[i] = v * 0.25;
  }
  return out;
}

/** Cents between two frequencies (100 cents = 1 semitone). */
function cents(a, b) {
  return 1200 * Math.log2(a / b);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---- 1. steady notes across a singing range ----
for (const hz of [98, 131, 196, 262, 330, 440, 587, 880]) {
  const track = await analyzePitch(fakeBuffer(makeVoice(1, () => hz)));
  // ignore the first/last 10 readings (they overlap the silence padding)
  const middle = Array.from(track.freqs.slice(10, -10));
  const voiced = middle.filter((f) => f > 0);
  const error = Math.abs(cents(median(voiced), hz));
  check(
    hz + " Hz steady note",
    voiced.length > middle.length * 0.95 && error < 5,
    "median error " + error.toFixed(2) + " cents, voiced " + voiced.length + "/" + middle.length
  );
}

// ---- 2. a note that slides up one octave over 2 seconds ----
{
  const f0 = 200;
  const freqAt = (t) => f0 * Math.pow(2, t / 2);
  const track = await analyzePitch(fakeBuffer(makeVoice(2, freqAt)));
  let worst = 0;
  let missing = 0;
  for (let i = 15; i < track.freqs.length - 15; i++) {
    const f = track.freqs[i];
    if (f <= 0) {
      missing++;
      continue;
    }
    worst = Math.max(worst, Math.abs(cents(f, freqAt(i * track.hop))));
  }
  check("glide up one octave", worst < 40 && missing === 0, "worst error " + worst.toFixed(1) + " cents, missing " + missing);
}

// ---- 3. vibrato: 220 Hz wobbling +/- half a semitone, 5.5 times a second ----
{
  const freqAt = (t) => 220 * Math.pow(2, (0.5 * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
  const track = await analyzePitch(fakeBuffer(makeVoice(2, freqAt)));
  const mids = Array.from(track.freqs.slice(15, -15)).filter((f) => f > 0).map(freqToMidi);
  const range = Math.max(...mids) - Math.min(...mids);
  const centre = mids.reduce((a, b) => a + b, 0) / mids.length;
  check(
    "vibrato is visible and centred on A3",
    range > 0.6 && range < 1.4 && Math.abs(centre - 57) < 0.1,
    "swing " + range.toFixed(2) + " semitones, centre MIDI " + centre.toFixed(2)
  );
}

// ---- 4. silence and noise must NOT produce pitches ----
{
  const silence = await analyzePitch(fakeBuffer(new Float32Array(SAMPLE_RATE)));
  check("silence has no pitch", silence.freqs.every((f) => f === 0));

  // simple repeatable pseudo-random noise
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const noise = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < noise.length; i++) noise[i] = rand() * 0.3;
  const track = await analyzePitch(fakeBuffer(noise));
  const voiced = track.freqs.filter((f) => f > 0).length;
  check("white noise is (almost) never called a pitch", voiced < track.freqs.length * 0.05, voiced + "/" + track.freqs.length + " voiced");
}

// ---- 5. a note with a gap in the middle: the gap must be unvoiced ----
{
  const tone = makeVoice(1.5, () => 330);
  tone.fill(0, Math.round(0.5 * SAMPLE_RATE), Math.round(1.0 * SAMPLE_RATE)); // silence 0.5s-1.0s
  const track = await analyzePitch(fakeBuffer(tone));
  const inGap = Array.from(track.freqs.slice(55, 95)); // 0.55 s .. 0.95 s
  check("gap in the middle is unvoiced", inGap.every((f) => f === 0));
  check("sound after the gap is found again", track.freqs[125] > 0 && Math.abs(cents(track.freqs[125], 330)) < 5);
}

// ---- 6. works on other sample rates / stereo-ish input without crashing ----
{
  const mono = makeVoice(0.5, () => 300);
  const buffer = fakeBuffer(mono);
  buffer.sampleRate = 48000; // pretend it was recorded at 48 kHz (pitch shifts, but must not crash)
  const track = await analyzePitch(buffer);
  check("48 kHz input runs", track.freqs.length > 40);
}

console.log(failures === 0 ? "\nAll tests passed." : "\n" + failures + " test(s) FAILED.");
process.exit(failures === 0 ? 0 : 1);
