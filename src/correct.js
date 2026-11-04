// correct.js
// The "editing brain": how a note's pitch is changed.
//
// Every note keeps two things:
//   center0       the pitch the singer really sang (never changes)
//   targetCenter  the pitch we WANT (starts equal to center0; dragging or
//                 "Correct Pitch" changes it)
//
// Inside a note the sung pitch wobbles. We split that wobble into two parts:
//   slow  = drift: the pitch slowly creeping up or down during the note
//   fast  = vibrato and tiny wiggles that make a voice sound alive
//
//   edited pitch = targetCenter + slow * (1 - driftAmount) + fast
//
// So "Pitch Drift 100%" flattens the creeping but keeps the vibrato, and moving
// the note only moves the centre. Stage 5 will use this edited pitch to
// re-synthesize the sound.

// ---- scales -----------------------------------------------------------------

// Which of the 12 semitones (counted up from the key note) belong to the scale.
export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
};

/**
 * The scale note closest to `midi`.
 * @param {number} midi   pitch as a note number (can have decimals)
 * @param {number} root   key note as 0..11 (0 = C, 1 = C#, ... 11 = B)
 * @param {string} scale  a key of SCALES
 */
export function snapToScale(midi, root = 0, scale = "chromatic") {
  const allowed = SCALES[scale] || SCALES.chromatic;
  const centre = Math.round(midi);
  let best = centre;
  let bestDistance = Infinity;
  for (let n = centre - 7; n <= centre + 7; n++) {
    const steps = (((n - root) % 12) + 12) % 12;
    if (!allowed.includes(steps)) continue;
    const distance = Math.abs(n - midi);
    if (distance < bestDistance) {
      best = n;
      bestDistance = distance;
    }
  }
  return best;
}

// ---- notes ------------------------------------------------------------------

const DRIFT_RADIUS = 12; // frames each side (12 -> a 250 ms window) that count as "slow"

/** Average of values around each position (window shrinks at the edges). */
function movingAverage(values, radius) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius);
    const to = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let k = from; k <= to; k++) sum += values[k];
    out[i] = sum / (to - from + 1);
  }
  return out;
}

/**
 * Give a freshly detected note its editing state.
 * The note needs `midi` (its pitch at every reading) and `center0`.
 */
export function initNote(note) {
  const deviation = new Float32Array(note.midi.length);
  for (let i = 0; i < deviation.length; i++) deviation[i] = note.midi[i] - note.center0;

  note.slow = movingAverage(deviation, DRIFT_RADIUS);
  note.fast = new Float32Array(deviation.length);
  for (let i = 0; i < deviation.length; i++) note.fast[i] = deviation[i] - note.slow[i];

  note.targetCenter = note.center0;
  note.drift = 0;       // 0..1, how much of the slow drift has been removed
  note.manual = false;  // true once the user has dragged this note by hand
  return note;
}

/** Has this note been changed from what was sung? */
export function isEdited(note) {
  return Math.abs(note.targetCenter - note.center0) > 0.005 || note.drift > 0.005;
}

/** The edited pitch (as note numbers) for every reading of the note. */
export function editedCurve(note) {
  // Cached, because the screen asks for this about 60 times a second.
  if (note._cacheCenter === note.targetCenter && note._cacheDrift === note.drift) {
    return note._cache;
  }
  const out = new Float32Array(note.midi.length);
  const keep = 1 - note.drift;
  for (let i = 0; i < out.length; i++) {
    out[i] = note.targetCenter + note.slow[i] * keep + note.fast[i];
  }
  note._cache = out;
  note._cacheCenter = note.targetCenter;
  note._cacheDrift = note.drift;
  return out;
}

// ---- snapshots (for undo, and for dragging) ---------------------------------

/** Remember the editable state of every note. */
export function takeSnapshot(notes) {
  return notes.map((n) => ({ targetCenter: n.targetCenter, drift: n.drift, manual: n.manual }));
}

/** Put every note back to a remembered state. */
export function restoreSnapshot(notes, snapshot) {
  notes.forEach((n, i) => {
    n.targetCenter = snapshot[i].targetCenter;
    n.drift = snapshot[i].drift;
    n.manual = snapshot[i].manual;
  });
}

export function snapshotsEqual(a, b) {
  return a.every(
    (s, i) => s.targetCenter === b[i].targetCenter && s.drift === b[i].drift && s.manual === b[i].manual
  );
}

// ---- the two edit operations --------------------------------------------------

/**
 * Move notes up or down by hand.
 * @param {object[]} notes
 * @param {number[]} indices   which notes to move
 * @param {object[]} start     snapshot taken when the drag began
 * @param {number}   semitones how far to move (can have decimals)
 */
export function moveNotes(notes, indices, start, semitones) {
  for (const i of indices) {
    notes[i].targetCenter = start[i].targetCenter + semitones;
    notes[i].manual = true;
  }
}

/**
 * The "Correct Pitch" command.
 *
 * @param {object[]} notes
 * @param {number[]} indices      notes to correct
 * @param {object[]} start        snapshot taken before correcting (so we always
 *                                work from the same starting point)
 * @param {object}   options
 * @param {number}   options.centerAmount   0..1  how far to move toward the target note
 * @param {number}   options.driftAmount    0..1  how much slow drift to remove
 * @param {boolean}  options.snap           true = snap to a scale, false = nearest semitone
 * @param {number}   options.root           key note 0..11
 * @param {string}   options.scale          a key of SCALES
 * @param {boolean}  options.includeManual  also correct notes the user moved by hand?
 */
export function correctPitch(notes, indices, start, options) {
  const { centerAmount, driftAmount, snap, root = 0, scale = "major", includeManual = false } = options;

  for (const i of indices) {
    const note = notes[i];
    if (start[i].manual && !includeManual) continue; // respect hand-made changes

    // Start from the sung pitch, or from the hand-placed pitch if we include those.
    const base = start[i].manual ? start[i].targetCenter : note.center0;
    const target = snapToScale(base, root, snap ? scale : "chromatic");

    note.targetCenter = base + (target - base) * centerAmount;
    note.drift = driftAmount;
    note.manual = false;
  }
}
