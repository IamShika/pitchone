// segment.js
// Turns the raw pitch track (one reading every 10 ms) into NOTES.
//
// Steps:
//   1. Convert Hz to note numbers.
//   2. Throw away glitches (single wrong readings, octave jumps).
//   3. Find phrases: stretches of singing separated by silence.
//   4. Inside each phrase, cut where the pitch steps to a new note.
//   5. Merge notes that are too short to be real, and measure each one.

import { freqToMidi } from "./notes.js";
import { initNote } from "./correct.js";

// All the numbers you can tune. One "frame" is one 10 ms reading.
export const SETTINGS = {
  glitchRadius: 3,       // median filter reaches this many frames each side (7 frames = 70 ms)
  minVoicedFrames: 5,    // a sound shorter than this (50 ms) is not a note
  gapFrames: 4,          // a silence this long (40 ms) ends a note. Shorter gaps are bridged
  splitPenalty: 5,       // how much a split must improve the fit to be worth it. Higher = fewer, longer notes
  minNoteFrames: 8,      // notes shorter than this (80 ms) are merged into a neighbour
  dipRatio: 0.4,         // a volume dip below 40% of the loudness around it re-starts the note ("la la la")
  dipSearchFrames: 12,   // how far (120 ms) each side we look for that loudness
  maxWander: 1.5,        // inside a note the pitch line may stray this many semitones from the note's centre; further = a detection glitch
};

// ---- small helpers ----------------------------------------------------------

function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median of the real (non-NaN) values around each frame. NaN stays NaN. */
function medianFilter(values, radius) {
  const out = new Float32Array(values.length);
  const window = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) {
      out[i] = NaN;
      continue;
    }
    window.length = 0;
    const from = Math.max(0, i - radius);
    const to = Math.min(values.length - 1, i + radius);
    for (let k = from; k <= to; k++) {
      if (!Number.isNaN(values[k])) window.push(values[k]);
    }
    out[i] = median(window);
  }
  return out;
}

/** Turn voiced stretches shorter than `minLength` into "no pitch". */
function removeShortRuns(values, minLength) {
  let i = 0;
  while (i < values.length) {
    if (Number.isNaN(values[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < values.length && !Number.isNaN(values[j])) j++;
    if (j - i < minLength) values.fill(NaN, i, j);
    i = j;
  }
}

/** Stretches of singing separated by silences of at least `gapFrames`. */
function findPhrases(values, gapFrames) {
  const phrases = [];
  let start = -1;
  let lastVoiced = -1;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isNaN(values[i])) {
      if (start < 0) start = i;
      lastVoiced = i;
    } else if (start >= 0 && i - lastVoiced >= gapFrames) {
      phrases.push({ start, end: lastVoiced + 1 });
      start = -1;
    }
  }
  if (start >= 0) phrases.push({ start, end: lastVoiced + 1 });
  return phrases;
}

/** Copy values[start..end) and fill short gaps with a straight line. */
function fillGaps(values, start, end) {
  const out = Float32Array.from(values.subarray(start, end));
  let i = 0;
  while (i < out.length) {
    if (!Number.isNaN(out[i])) {
      i++;
      continue;
    }
    let j = i;
    while (Number.isNaN(out[j])) j++; // a phrase begins and ends with real values
    const a = out[i - 1];
    const b = out[j];
    for (let k = i; k < j; k++) out[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return out;
}

function mean(values, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i];
  return sum / (to - from);
}

/**
 * Where does the pitch jump to a new note? Returns frame numbers (relative to
 * the start of `curve`) where a new note begins.
 *
 * Idea: describe the curve as a staircase of flat notes. A staircase with more
 * steps always fits the wobbly curve better, so every extra step has to "pay"
 * a penalty. A real step to another note improves the fit a lot (worth it).
 * Vibrato improves it only a little (not worth it), so it never gets cut.
 * This is called "optimal partitioning" (we use the fast PELT version).
 */
function findSteps(curve, settings) {
  const n = curve.length;
  const penalty = settings.splitPenalty;

  // Running totals, so the cost of any stretch can be computed instantly.
  const sum = new Float64Array(n + 1);
  const sumSquares = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + curve[i];
    sumSquares[i + 1] = sumSquares[i] + curve[i] * curve[i];
  }
  // How badly does ONE flat note fit frames a..b-1? (sum of squared differences)
  const cost = (a, b) => sumSquares[b] - sumSquares[a] - ((sum[b] - sum[a]) ** 2) / (b - a);

  const best = new Float64Array(n + 1); // best[t] = cheapest staircase for the first t frames
  const lastCut = new Int32Array(n + 1);
  best[0] = -penalty;
  let candidates = [0];

  for (let t = 1; t <= n; t++) {
    let bestValue = Infinity;
    let bestFrom = 0;
    for (const s of candidates) {
      const value = best[s] + cost(s, t) + penalty;
      if (value < bestValue) {
        bestValue = value;
        bestFrom = s;
      }
    }
    best[t] = bestValue;
    lastCut[t] = bestFrom;
    // PELT trick: forget starting points that can never win again
    candidates = candidates.filter((s) => best[s] + cost(s, t) <= bestValue);
    candidates.push(t);
  }

  // Walk backwards to collect the cuts
  const cuts = [];
  for (let t = lastCut[n]; t > 0; t = lastCut[t]) cuts.push(t);
  return cuts.reverse();
}

/**
 * Singers repeat the same note ("la la la") without changing pitch, so the pitch
 * alone cannot tell where one note ends. But the volume dips between them.
 * Returns frame numbers (relative to the start of `level`) of such dips.
 */
function findLevelDips(level, settings) {
  const r = settings.dipSearchFrames;
  const n = level.length;
  const cuts = [];
  let i = r;
  while (i < n - r) {
    const leftMax = Math.max(...level.subarray(i - r, i));
    const rightMax = Math.max(...level.subarray(i + 1, i + r + 1));
    if (level[i] < settings.dipRatio * Math.min(leftMax, rightMax)) {
      // one dip can last several frames: cut at its lowest point
      let best = i;
      let j = i;
      while (j < n - r) {
        const lm = Math.max(...level.subarray(j - r, j));
        const rm = Math.max(...level.subarray(j + 1, j + r + 1));
        if (level[j] >= settings.dipRatio * Math.min(lm, rm)) break;
        if (level[j] < level[best]) best = j;
        j++;
      }
      cuts.push(best);
      i = j;
    } else {
      i++;
    }
  }
  return cuts;
}

/**
 * Inside a finished note, a reading far away from the note's centre, or taken
 * while the sound is almost silent, is a detection glitch (they happen where a
 * note fades in or out). Replace those readings with a straight line between
 * the good ones next to them (or hold the nearest good value at the ends).
 */
function repairGlitches(curve, level, centre, limit) {
  const out = Float32Array.from(curve);
  const quiet = 0.25 * Math.max(...level); // readings much quieter than the note's loudest part are unreliable too
  const bad = (i) => Math.abs(out[i] - centre) > limit || level[i] < quiet;
  let i = 0;
  while (i < out.length) {
    if (!bad(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && bad(j)) j++;
    const before = i > 0 ? out[i - 1] : j < out.length ? out[j] : centre; // nearest good value on each side
    const after = j < out.length ? out[j] : before;
    for (let k = i; k < j; k++) out[k] = before + ((after - before) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return out;
}

/** Join notes that are too short onto the neighbour with the closest pitch. */
function mergeShortSegments(segments, curve, minFrames) {
  const centreOf = (s) => median(curve.subarray(s.a, s.b));
  for (;;) {
    let shortest = -1;
    for (let i = 0; i < segments.length; i++) {
      const length = segments[i].b - segments[i].a;
      if (length < minFrames && (shortest < 0 || length < segments[shortest].b - segments[shortest].a)) {
        shortest = i;
      }
    }
    if (shortest < 0) return segments;

    if (segments.length === 1) return []; // a lone short blip is not a note
    const s = segments[shortest];
    const left = segments[shortest - 1];
    const right = segments[shortest + 1];
    let into;
    if (!left) into = right;
    else if (!right) into = left;
    else {
      const c = centreOf(s);
      into = Math.abs(centreOf(left) - c) <= Math.abs(centreOf(right) - c) ? left : right;
    }
    into.a = Math.min(into.a, s.a);
    into.b = Math.max(into.b, s.b);
    segments.splice(shortest, 1);
  }
}

// ---- the main function --------------------------------------------------------

/**
 * @param {{hop:number, freqs:Float32Array, level?:Float32Array}} track  from analyzePitch()
 * @returns {{notes: object[], refLevel: number}}
 *   notes     each has start/end (seconds), startFrame/endFrame, midi (pitch per
 *             frame), level (loudness per frame), center0, targetCenter, drift ...
 *   refLevel  a "loud" volume, used to scale how thick the blobs are drawn
 */
export function buildNotes(track, settings = SETTINGS) {
  const count = track.freqs.length;

  // 1. note numbers (NaN = no pitch here)
  const midi = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    midi[i] = track.freqs[i] > 0 ? freqToMidi(track.freqs[i]) : NaN;
  }

  // 2. glitches
  const clean = medianFilter(midi, settings.glitchRadius);
  removeShortRuns(clean, settings.minVoicedFrames);

  // loudness, lightly smoothed
  const rawLevel = track.level || new Float32Array(count).fill(1);
  const level = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const from = Math.max(0, i - 3);
    const to = Math.min(count - 1, i + 3);
    level[i] = mean(rawLevel, from, to + 1);
  }

  // 3 + 4 + 5
  const notes = [];
  const loudValues = [];
  for (const phrase of findPhrases(clean, settings.gapFrames)) {
    const curve = fillGaps(clean, phrase.start, phrase.end);

    // cut where the pitch steps to a new note OR the volume dips between repeated notes
    const loudness = rawLevel.subarray(phrase.start, phrase.end);
    const cuts = [...new Set([...findSteps(curve, settings), ...findLevelDips(loudness, settings)])]
      .filter((c) => c > 0 && c < curve.length)
      .sort((a, b) => a - b);
    let segments = [];
    let a = 0;
    for (const cut of cuts) {
      segments.push({ a, b: cut });
      a = cut;
    }
    segments.push({ a, b: curve.length });
    segments = mergeShortSegments(segments, curve, settings.minNoteFrames);

    for (const s of segments) {
      const startFrame = phrase.start + s.a;
      const endFrame = phrase.start + s.b;
      const note = {
        id: notes.length,
        startFrame,
        endFrame,
        start: startFrame * track.hop,
        end: endFrame * track.hop,
        midi: null,
        level: level.slice(startFrame, endFrame),
        center0: median(curve.subarray(s.a, s.b)),
      };
      note.midi = repairGlitches(curve.subarray(s.a, s.b), note.level, note.center0, settings.maxWander);
      initNote(note);
      notes.push(note);
      for (let i = 0; i < note.level.length; i += 3) loudValues.push(note.level[i]);
    }
  }

  // "loud" = the 90th percentile of all note loudness values
  loudValues.sort((a, b) => a - b);
  const refLevel = loudValues.length ? loudValues[Math.floor(loudValues.length * 0.9)] : 1;

  return { notes, refLevel: refLevel > 0 ? refLevel : 1 };
}
