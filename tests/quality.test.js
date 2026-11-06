// tests/quality.test.js
// Run with:  node tests/quality.test.js
//
// Checks the pitch shifter on MESSY, realistic voices (see voice.js): the
// vocal-cord pulses wobble in timing and loudness, there is breath noise, and
// the singer uses vibrato. A shifter that only works on clean test tones fails here.
//
// We compare the shifted voice with an "ideal" one: the same voice, generated
// directly at the new pitch. The shifted voice should be about as clean and
// steady (periodicity), keep the same tone colour (spectrum distance), and
// not jump around in loudness (flutter).

import { analyzePitch } from "../src/pitch.js";
import { buildNotes } from "../src/segment.js";
import { renderEdited } from "../src/psola.js";
import { makeVoice, singerPitch } from "./voice.js";
import { periodicity, flutter, spectrumDistance } from "./metrics.js";
import { check, finish } from "./check.js";

const SR = 44100;
const SECONDS = 1.6;
const fake = (d) => ({ sampleRate: SR, length: d.length, numberOfChannels: 1, duration: d.length / SR, getChannelData: () => d });

const voices = [
  { name: "mild male 'ah' (120 Hz)", hz: 120, vowel: "ah", seed: 3, jitter: 0.008, shimmer: 0.05, breath: 0.1, vibrato: 0.4 },
  { name: "mild female 'ee' (230 Hz)", hz: 230, vowel: "ee", seed: 5, jitter: 0.008, shimmer: 0.05, breath: 0.1, vibrato: 0.4 },
  { name: "rough male 'oo' (100 Hz)", hz: 100, vowel: "oo", seed: 7, jitter: 0.015, shimmer: 0.12, breath: 0.3, vibrato: 0.7 },
  { name: "breathy female 'ah' (260 Hz)", hz: 260, vowel: "ah", seed: 9, jitter: 0.01, shimmer: 0.1, breath: 0.3, vibrato: 0.6 },
];

for (const v of voices) {
  const pitchAt = singerPitch(v.hz, { seconds: SECONDS, vibratoSemitones: v.vibrato, vibratoHz: 6 });
  const make = (f) => makeVoice({ seconds: SECONDS, freqAt: f, vowel: v.vowel, seed: v.seed, jitter: v.jitter, shimmer: v.shimmer, breath: v.breath });
  const original = make(pitchAt);
  const track = await analyzePitch(fake(original));

  for (const shift of [-5, -2, 2, 5, 7]) {
    const { notes } = buildNotes(track);
    notes.forEach((n) => (n.targetCenter += shift));
    const [shifted] = renderEdited([original], SR, notes, track.hop);
    const ideal = make((t) => pitchAt(t) * Math.pow(2, shift / 12));
    const label = v.name + ", " + (shift > 0 ? "+" : "") + shift + " semitones";
    // Look at the middle of the longest note. (Where a messy voice makes the note finder cut the
    // note into pieces, the gaps stay "as sung", and that is a note-finding matter, not a shifter one.)
    const longest = notes.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const [from, to] = [longest.start + 0.06, longest.end - 0.06];

    check(label + ": there is a note long enough to judge", to - from > 0.25, (to - from).toFixed(2) + " s");
    const steady = periodicity(shifted, SR, from, to);
    const reference = periodicity(original, SR, from, to);
    check(label + ": as steady as the original recording", steady.mean > reference.mean - 0.06, steady.mean.toFixed(3) + " vs " + reference.mean.toFixed(3));
    check(label + ": no bad patches", steady.worst > reference.worst - 0.15, "worst 5%: " + steady.worst.toFixed(3) + " vs " + reference.worst.toFixed(3));
    check(label + ": loudness does not flutter", flutter(shifted, SR, from, to) < flutter(ideal, SR, from, to) * 1.6 + 0.3);
    const distance = spectrumDistance(shifted, ideal, SR, from, to);
    check(label + ": tone colour matches a voice sung at that pitch", distance < 5, distance.toFixed(1) + " dB apart");
  }
}

finish();
