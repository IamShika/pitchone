// view.js
// Where are we looking? The "view" says which part of the recording and which
// range of notes is on screen, and converts between screen pixels and
// (seconds, note number).
//
//   view.t0        the time (seconds) at the left edge of the roll
//   view.pxPerSec  how many CSS pixels one second takes (zoom in time)
//   view.midiTop   the note number at the very top edge
//   view.rowH      how many CSS pixels one semitone row takes (zoom in pitch)
//
// All x/y values here are relative to the top-left corner of the roll area
// (not counting the note-name column on the left).

export function createView() {
  return { t0: 0, pxPerSec: 100, midiTop: 72.5, rowH: 12 };
}

export const xOfTime = (v, t) => (t - v.t0) * v.pxPerSec;
export const timeOfX = (v, x) => x / v.pxPerSec + v.t0;
export const yOfMidi = (v, m) => (v.midiTop - m) * v.rowH;
export const midiOfY = (v, y) => v.midiTop - y / v.rowH;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Zoom limits for a given recording and roll size. */
function limits(size) {
  return {
    minPxPerSec: size.width / Math.max(size.duration, 0.5), // whole recording fits
    maxPxPerSec: 1200,
    minRowH: size.height / 60,                              // about 5 octaves fit
    maxRowH: 90,
  };
}

/** Keep the view inside sensible bounds. `size` = {width, height, duration}. */
export function clampView(v, size) {
  const lim = limits(size);
  v.pxPerSec = clamp(v.pxPerSec, lim.minPxPerSec, lim.maxPxPerSec);
  v.rowH = clamp(v.rowH, lim.minRowH, lim.maxRowH);

  const visibleSeconds = size.width / v.pxPerSec;
  v.t0 = clamp(v.t0, 0, Math.max(0, size.duration - visibleSeconds));

  const visibleSemitones = size.height / v.rowH;
  const highest = 120.5; // about C9
  const lowest = 11.5;
  v.midiTop = clamp(v.midiTop, lowest + visibleSemitones, highest);
  return v;
}

/**
 * Zoom by a factor in time (fx) and in pitch (fy), keeping the point under
 * (anchorX, anchorY) where it is.
 */
export function zoomAt(v, anchorX, anchorY, fx, fy, size) {
  const time = timeOfX(v, anchorX);
  const midi = midiOfY(v, anchorY);
  v.pxPerSec *= fx;
  v.rowH *= fy;
  clampView(v, size); // clamp zoom first, so the anchor maths below uses the real zoom
  v.t0 = time - anchorX / v.pxPerSec;
  v.midiTop = midi + anchorY / v.rowH;
  return clampView(v, size);
}

/**
 * Show the whole recording and all of its notes.
 * @param {object} v
 * @param {object[]} notes
 * @param {{width:number,height:number,duration:number}} size
 */
export function fitView(v, notes, size) {
  let lo = 60;
  let hi = 72;
  if (notes.length > 0) {
    lo = Math.floor(Math.min(...notes.map((n) => n.targetCenter))) - 2;
    hi = Math.ceil(Math.max(...notes.map((n) => n.targetCenter))) + 2;
  }
  // always show at least an octave and a bit, so the rows don't get huge
  while (hi - lo + 1 < 14) {
    lo--;
    if (hi - lo + 1 < 14) hi++;
  }
  v.t0 = 0;
  v.pxPerSec = size.width / Math.max(size.duration, 0.5);
  v.rowH = size.height / (hi - lo + 1);
  v.midiTop = hi + 0.5;
  return clampView(v, size);
}

/** Pick a spacing for the vertical time lines so they are not too crowded. */
export function chooseTimeStep(pxPerSec) {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of steps) {
    if (step * pxPerSec >= 64) return step;
  }
  return steps[steps.length - 1];
}

/**
 * Two-finger pinch: zoom by (fx, fy) from the view as it was when the pinch
 * began (`start`), and move so the spot that was under the fingers' starting
 * centre (`from`) is now under their current centre (`to`).
 */
export function pinchTo(v, start, from, to, fx, fy, size) {
  const time = timeOfX(start, from.x);
  const midi = midiOfY(start, from.y);
  v.pxPerSec = start.pxPerSec * fx;
  v.rowH = start.rowH * fy;
  clampView(v, size); // applies the zoom limits first
  v.t0 = time - to.x / v.pxPerSec;
  v.midiTop = midi + to.y / v.rowH;
  return clampView(v, size);
}
