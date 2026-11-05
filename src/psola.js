// psola.js
// Changes the pitch of a recorded voice WITHOUT changing its speed or its
// "voice character". The method is called PSOLA (pitch-synchronous overlap-add).
//
// The idea, in plain words:
//   A voiced sound is a wave that repeats once per "period" (about 5 ms for a
//   200 Hz voice). Every repeat is a little "grain" of the voice.
//     1. Cut the recording into overlapping grains, one around every period.
//     2. To raise the pitch, place the grains CLOSER together (more repeats per
//        second). To lower it, place them FURTHER apart.
//     3. Overlap-add them back into one sound.
//   Each grain still has the voice's original shape, so the tone colour
//   (the "formants") stays. And because we use the original time line, the
//   result is just as long as before.
//
// Everything is measured in samples (one sample = 1 / sampleRate seconds).

import { midiToFreq } from "./notes.js";
import { editedCurve, isEdited } from "./correct.js";

const FADE_SECONDS = 0.015;   // crossfade between the original and the shifted sound at a note's edges
const PAD_SECONDS = 0.03;     // extra audio rendered before / after a note so the crossfade has material
const MIN_RATIO = 0.4;        // never shift further than this (about -16 semitones)
const MAX_RATIO = 2.5;        // ... or this (about +16 semitones)

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Mix any number of channels down to one (used to find the pitch marks). */
export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const data of channels) {
    for (let i = 0; i < out.length; i++) out[i] += data[i] / channels.length;
  }
  return out;
}

/** Value of a per-reading array at any time (in seconds), blended between readings. */
function valueAt(array, hop, firstTime, seconds) {
  const position = (seconds - firstTime) / hop;
  const i = Math.floor(position);
  const fraction = position - i;
  const a = array[clamp(i, 0, array.length - 1)];
  const b = array[clamp(i + 1, 0, array.length - 1)];
  return a + (b - a) * fraction;
}

/**
 * Pitch marks: one position per wave repeat, each sitting on the wave's peak.
 * Grains are centred on these marks.
 */
function findPitchMarks(x, sampleRate, note, hop, from, to) {
  const periodAt = (i) => sampleRate / midiToFreq(valueAt(note.midi, hop, note.start, i / sampleRate));
  const marks = [];

  // first mark: the highest peak in the first period
  let best = from;
  const firstEnd = Math.min(to, Math.floor(from + periodAt(from)));
  for (let j = from; j < firstEnd; j++) if (x[j] > x[best]) best = j;
  marks.push(best);

  // then hop one period at a time, snapping to the nearest peak
  for (;;) {
    const last = marks[marks.length - 1];
    const period = periodAt(last);
    const nominal = last + period;
    if (nominal - 0.25 * period > to) break;
    const lo = Math.max(last + 1, Math.round(nominal - 0.25 * period));
    const hi = Math.min(x.length - 1, Math.round(nominal + 0.25 * period));
    if (lo > hi) break;
    let peak = lo;
    for (let j = lo; j <= hi; j++) if (x[j] > x[peak]) peak = j;
    marks.push(peak);
  }
  return marks;
}

/**
 * Re-create the part of the recording around one note at its edited pitch.
 *
 * @param {Float32Array[]} channels   the original audio (one array per channel)
 * @param {Float32Array}   mono       the same audio mixed to one channel
 * @param {number}         sampleRate
 * @param {object}         note       a note from segment.js (with its edit state)
 * @param {number}         hop        seconds between pitch readings
 * @returns {{start:number, channels:Float32Array[]}}
 *   start     the sample number in the recording where the new audio begins
 *   channels  the new audio, one array per channel
 */
export function renderNote(channels, mono, sampleRate, note, hop) {
  const length = mono.length;
  const from = clamp(Math.floor((note.start - PAD_SECONDS) * sampleRate), 0, length - 1);
  const to = clamp(Math.ceil((note.end + PAD_SECONDS) * sampleRate), from + 1, length);

  // The marks only depend on the sound as sung, never on edits, so keep them.
  if (!note._marks || note._marksKey !== from + ":" + to) {
    note._marks = findPitchMarks(mono, sampleRate, note, hop, from, to);
    note._marksKey = from + ":" + to;
  }
  const marks = note._marks;

  const edited = editedCurve(note); // the pitch we WANT, per reading (in note numbers)
  const sung = note.midi;           // the pitch that was sung
  const periodAt = (i) => sampleRate / midiToFreq(valueAt(sung, hop, note.start, i / sampleRate));
  const ratioAt = (i) => {
    const t = i / sampleRate;
    const semitones = valueAt(edited, hop, note.start, t) - valueAt(sung, hop, note.start, t);
    return clamp(Math.pow(2, semitones / 12), MIN_RATIO, MAX_RATIO);
  };

  const out = channels.map(() => new Float32Array(to - from));

  // Walk along the new time line placing one grain per NEW period.
  let nearest = 0; // index of the analysis mark closest to where we are
  let position = marks[0] - from; // where the next grain is centred in the output
  while (position < to - from) {
    const here = from + position;
    while (nearest + 1 < marks.length && Math.abs(marks[nearest + 1] - here) < Math.abs(marks[nearest] - here)) nearest++;

    const centre = marks[nearest];
    const period = periodAt(centre);   // length of one repeat in the sung sound
    const ratio = ratioAt(here);       // 2 = one octave up
    const half = Math.max(2, Math.round(period)); // the grain is two periods long (half on each side)
    const gain = 1 / ratio;            // overlapping more or fewer grains changes loudness: undo that

    const outCentre = Math.round(position);
    for (let n = -half; n <= half; n++) {
      const source = centre + n;
      const target = outCentre + n;
      if (source < 0 || source >= length || target < 0 || target >= to - from) continue;
      const weight = 0.5 * (1 + Math.cos((Math.PI * n) / half)) * gain; // Hann window: fades the grain's edges
      for (let c = 0; c < channels.length; c++) out[c][target] += channels[c][source] * weight;
    }

    position += period / ratio; // the NEW period: shorter when the pitch goes up
  }

  return { start: from, channels: out };
}

/** Smooth 0 -> 1 curve (used for the crossfades). */
function smoothstep(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Build the whole recording with every edited note at its new pitch.
 * Everything that was not edited (silence, breaths, consonants, untouched
 * notes) is copied from the original, so it stays exactly as it was.
 *
 * @param {Float32Array[]} channels   original audio, one array per channel
 * @param {number} sampleRate
 * @param {object[]} notes
 * @param {number} hop
 * @returns {Float32Array[]} new audio, same length as the original
 */
export function renderEdited(channels, sampleRate, notes, hop) {
  const mono = mixToMono(channels);
  const result = channels.map((data) => Float32Array.from(data));
  const fade = FADE_SECONDS * sampleRate;

  for (const note of notes) {
    if (!isEdited(note)) continue;
    const piece = renderNote(channels, mono, sampleRate, note, hop);
    const startSample = note.start * sampleRate;
    const endSample = note.end * sampleRate;

    for (let n = 0; n < piece.channels[0].length; n++) {
      const i = piece.start + n;
      // 0 outside the note, ramping to 1 across `fade` samples at each edge
      const weight = smoothstep((i - (startSample - fade / 2)) / fade) * (1 - smoothstep((i - (endSample - fade / 2)) / fade));
      if (weight <= 0) continue;
      for (let c = 0; c < channels.length; c++) {
        result[c][i] += weight * (piece.channels[c][n] - channels[c][i]);
      }
    }
  }
  return result;
}
