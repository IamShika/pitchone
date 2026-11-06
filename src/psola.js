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

const FADE_SECONDS = 0.025;   // crossfade between the original and the shifted sound at a note's edges
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
 * Pitch marks: one position per wave repeat.
 *
 * A real voice never repeats EXACTLY, and its waveform often has several similar
 * peaks per repeat, so "pick the highest peak" jumps between peaks and the grains
 * no longer line up (that is a buzzy, glitchy sound). Instead we follow the wave
 * like this: look at the shape of the previous repeat, then look for the place
 * about one period later where the shape matches it best. That keeps every mark
 * at the same point of the wave cycle, however messy the voice is.
 *
 * To stay fast the search is done on a low-resolution copy of the sound first,
 * and then fine-tuned on the real samples.
 */
function findPitchMarks(x, sampleRate, note, hop, from, to) {
  const periodAt = (i) => sampleRate / midiToFreq(valueAt(note.midi, hop, note.start, i / sampleRate));

  // a low-resolution copy: every `step` samples averaged into one
  const step = Math.max(1, Math.floor(sampleRate / 11025));
  const small = new Float32Array(Math.ceil((to - from) / step));
  for (let i = 0; i < small.length; i++) {
    let sum = 0, n = 0;
    for (let j = from + i * step; j < from + (i + 1) * step && j < to; j++) { sum += x[j]; n++; }
    small[i] = n ? sum / n : 0;
  }

  /** How well the slice around `b` matches the slice around `a` (1 = identical). Slices are `size` long. */
  const similarity = (data, a, b, size) => {
    const half = size >> 1;
    let cross = 0, e1 = 0, e2 = 0;
    for (let i = -half; i < size - half; i++) {
      const u = data[a + i], v = data[b + i];
      if (u === undefined || v === undefined) continue;
      cross += u * v; e1 += u * u; e2 += v * v;
    }
    return cross / Math.sqrt(e1 * e2 + 1e-12);
  };

  // first mark: the loudest spot in the first period
  let first = from;
  const firstEnd = Math.min(to, Math.floor(from + 1.2 * periodAt(from)));
  for (let j = from; j < firstEnd; j++) if (Math.abs(x[j]) > Math.abs(x[first])) first = j;
  const marks = [first];

  for (;;) {
    const last = marks[marks.length - 1];
    const period = periodAt(last);
    if (last + 1.3 * period + period / 2 > to) break;

    // coarse search on the small copy
    const smallLast = Math.round((last - from) / step);
    const smallPeriod = period / step;
    const size = Math.max(4, Math.round(smallPeriod));
    let bestSmall = Math.round(smallLast + smallPeriod);
    let bestScore = -Infinity;
    const lo = Math.round(smallLast + 0.75 * smallPeriod);
    const hi = Math.round(smallLast + 1.25 * smallPeriod);
    for (let c = lo; c <= hi; c++) {
      // a tiny preference for "about one period" breaks ties between equal matches
      const score = similarity(small, smallLast, c, size) - 0.05 * Math.abs(c - smallLast - smallPeriod) / smallPeriod;
      if (score > bestScore) { bestScore = score; bestSmall = c; }
    }

    // fine search on the real samples around the coarse answer
    const guess = from + bestSmall * step;
    let best = guess;
    let bestFine = -Infinity;
    const fullSize = Math.max(8, Math.round(period));
    for (let c = guess - step; c <= guess + step; c++) {
      if (c <= last) continue;
      const score = similarity(x, last, c, fullSize);
      if (score > bestFine) { bestFine = score; best = c; }
    }
    if (best >= x.length) break;
    marks.push(best);
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
  const size = to - from;

  // The marks only depend on the sound as sung, never on edits, so keep them.
  if (!note._marks || note._marksKey !== from + ":" + to) {
    note._marks = findPitchMarks(mono, sampleRate, note, hop, from, to);
    note._marksKey = from + ":" + to;
  }
  const marks = note._marks;

  const edited = editedCurve(note); // the pitch we WANT, per reading (in note numbers)
  const sung = note.midi;           // the pitch that was sung
  const ratioAt = (i) => {
    const t = i / sampleRate;
    const semitones = valueAt(edited, hop, note.start, t) - valueAt(sung, hop, note.start, t);
    return clamp(Math.pow(2, semitones / 12), MIN_RATIO, MAX_RATIO);
  };
  // The length of one repeat around mark k, measured from the marks themselves and
  // averaged over a few neighbours: a real voice wobbles from repeat to repeat, and
  // copying every tiny wobble into the new sound would make it rough.
  const AVERAGE_OVER = 3; // marks on each side
  const periodOfMark = (k) => {
    const lo = Math.max(0, k - AVERAGE_OVER);
    const hi = Math.min(marks.length - 1, k + AVERAGE_OVER);
    return hi > lo ? (marks[hi] - marks[lo]) / (hi - lo) : sampleRate / 200;
  };

  // `sum` collects the grains. `norm` collects how much (gain-corrected) window
  // overlapped each sample. `denseNorm` is the part of it that came from grains
  // placed closer together than the sung period (pitch going UP).
  const sum = channels.map(() => new Float32Array(size));
  const norm = new Float32Array(size);
  const denseNorm = new Float32Array(size);

  let nearest = 0;                // index of the analysis mark closest to where we are
  let position = marks[0] - from; // where the next grain is centred in the output
  while (position < size) {
    const here = from + position;
    while (nearest + 1 < marks.length && Math.abs(marks[nearest + 1] - here) < Math.abs(marks[nearest] - here)) nearest++;

    const centre = marks[nearest];
    const period = periodOfMark(nearest);         // one repeat of the sung sound
    const ratio = ratioAt(here);                  // 2 = one octave up
    const newPeriod = period / ratio;             // one repeat of the NEW sound: shorter when going up
    // Hann window: two sung periods long. (It must NOT be longer when the pitch goes
    // down: the dips between the grains are what makes the new, lower pitch.)
    const half = Math.max(4, Math.round(period));
    // Overlapping more or fewer grains changes the loudness: undo that.
    const gain = 1 / ratio;

    const outCentre = Math.round(position);
    for (let n = -half; n <= half; n++) {
      const source = centre + n;
      const target = outCentre + n;
      if (source < 0 || source >= length || target < 0 || target >= size) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * n) / half)) * gain; // fades the grain's edges
      norm[target] += w;
      if (ratio >= 1) denseNorm[target] += w;
      for (let c = 0; c < channels.length; c++) sum[c][target] += channels[c][source] * w;
    }
    position += newPeriod;
  }

  // Finish. Where grains overlap a lot (pitch going up) the overlap is uneven
  // (a faint ripple), so divide it out. Where they are far apart (pitch going
  // down) leave it, because the gaps ARE the new pitch. Where nothing was
  // placed at all (the very ends), keep the original sound.
  const out = sum;
  for (let n = 0; n < size; n++) {
    if (norm[n] < 1e-4) {
      for (let c = 0; c < channels.length; c++) out[c][n] = channels[c][from + n];
      continue;
    }
    if (denseNorm[n] >= 0.99 * norm[n]) {
      const missing = Math.max(0, 0.3 - norm[n]);
      const divide = Math.max(norm[n], 0.3);
      for (let c = 0; c < channels.length; c++) out[c][n] = (sum[c][n] + channels[c][from + n] * missing) / divide;
    }
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
