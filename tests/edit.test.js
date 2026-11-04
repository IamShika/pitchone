// tests/edit.test.js
// Run with:  node tests/edit.test.js
//
// Tests for the editing maths: scales, moving notes, Correct Pitch, drift,
// undo/redo, and the zoom/pan view.

import {
  snapToScale, initNote, editedCurve, isEdited, takeSnapshot, restoreSnapshot,
  snapshotsEqual, moveNotes, correctPitch,
} from "../src/correct.js";
import { createHistory } from "../src/history.js";
import { createView, fitView, zoomAt, clampView, xOfTime, timeOfX, yOfMidi, midiOfY, chooseTimeStep } from "../src/view.js";
import { check, finish } from "./check.js";

/** A note whose pitch is `centre` plus whatever `wobble(i)` says, for `frames` readings. */
function makeNote(centre, frames, wobble = () => 0) {
  const midi = Float32Array.from({ length: frames }, (_, i) => centre + wobble(i));
  const sorted = Array.from(midi).sort((a, b) => a - b);
  return initNote({
    start: 0, end: frames * 0.01, startFrame: 0, endFrame: frames,
    midi, level: new Float32Array(frames).fill(0.2), center0: sorted[frames >> 1],
  });
}

// ---- scales ----
check("60.4 snaps to 60 (chromatic)", snapToScale(60.4, 0, "chromatic") === 60);
check("60.6 snaps to 61 (chromatic)", snapToScale(60.6, 0, "chromatic") === 61);
check("61.4 snaps to 62 in C major (C# is not in the scale)", snapToScale(61.4, 0, "major") === 62);
check("66.2 snaps to 67 in C major", snapToScale(66.2, 0, "major") === 67);
check("61.2 snaps to 62 in A minor", snapToScale(61.2, 9, "minor") === 62);
check("works in other octaves and keys (F major, near C#2)", snapToScale(37.3, 5, "major") === 38);
check("an in-scale note stays put", snapToScale(64.05, 0, "major") === 64);

// ---- moving notes by hand ----
{
  const notes = [makeNote(60, 50), makeNote(64, 50)];
  const start = takeSnapshot(notes);
  moveNotes(notes, [1], start, 2);
  check("dragging moves only the chosen note", notes[0].targetCenter === 60 && notes[1].targetCenter === 66);
  check("a dragged note is marked as hand-edited", notes[1].manual && !notes[0].manual);
  moveNotes(notes, [1], start, 3); // the drag continues: still relative to the START
  check("a drag is measured from where it began", notes[1].targetCenter === 67);
  check("sung pitch is never lost", notes[1].center0 === 64);
  restoreSnapshot(notes, start);
  check("restoring a snapshot undoes the move", notes[1].targetCenter === 64 && !notes[1].manual);
}

// ---- edited curve ----
{
  const note = makeNote(60, 100, (i) => 0.5 * Math.sin(i / 3)); // vibrato-like wobble
  const original = Array.from(note.midi);
  note.targetCenter += 2;
  const moved = editedCurve(note);
  const allShifted = original.every((m, i) => Math.abs(moved[i] - (m + 2)) < 1e-4);
  check("moving a note shifts the whole curve (vibrato kept)", allShifted);
  check("isEdited notices the change", isEdited(note));
  const again = editedCurve(note);
  check("the curve is cached until something changes", again === moved);
  note.targetCenter = note.center0;
  check("an untouched note is not 'edited'", !isEdited(note));
}

// ---- pitch drift ----
{
  // a note that creeps upward by 0.8 semitones over 1.2 s, with vibrato on top
  const note = makeNote(60, 120, (i) => (0.8 * i) / 120 + 0.3 * Math.sin((2 * Math.PI * 5.5 * i) / 100));

  // slope of the best straight line through the middle of the curve (semitones per reading)
  const slope = (curve) => {
    const y = Array.from(curve).slice(15, -15);
    const n = y.length;
    const meanX = (n - 1) / 2;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    y.forEach((v, i) => { num += (i - meanX) * (v - meanY); den += (i - meanX) ** 2; });
    return num / den;
  };
  const range = (curve) => {
    const y = Array.from(curve).slice(15, -15);
    return Math.max(...y) - Math.min(...y);
  };

  const before = slope(editedCurve(note));
  const rangeBefore = range(editedCurve(note));
  note.drift = 1;
  const after = slope(editedCurve(note));
  check("Pitch Drift 100% removes the slow creep", Math.abs(after) < Math.abs(before) * 0.15, "slope " + (before * 100).toFixed(2) + " -> " + (after * 100).toFixed(2) + " semitones/s");
  check("...but the vibrato is still there", range(editedCurve(note)) > 0.45 && range(editedCurve(note)) < rangeBefore, "wobble range " + range(editedCurve(note)).toFixed(2));

  note.drift = 0.5;
  const half = slope(editedCurve(note));
  check("Pitch Drift 50% removes about half", Math.abs(half) > Math.abs(before) * 0.3 && Math.abs(half) < Math.abs(before) * 0.7);
}

// ---- Correct Pitch ----
{
  const make = () => [makeNote(60.3, 50), makeNote(61.4, 50), makeNote(64.8, 50)];

  let notes = make();
  correctPitch(notes, [0, 1, 2], takeSnapshot(notes), { centerAmount: 1, driftAmount: 0, snap: false });
  check("100% moves each note to the nearest semitone", notes.map((n) => n.targetCenter.toFixed(2)).join(" ") === "60.00 61.00 65.00", notes.map((n) => n.targetCenter.toFixed(2)).join(" "));

  notes = make();
  correctPitch(notes, [0, 1, 2], takeSnapshot(notes), { centerAmount: 1, driftAmount: 0, snap: true, root: 0, scale: "major" });
  check("snap to C major: C#-ish note goes to D, F#-ish to F or G", notes[1].targetCenter === 62 && notes[2].targetCenter === 65, notes.map((n) => n.targetCenter).join(" "));

  notes = make();
  correctPitch(notes, [0], takeSnapshot(notes), { centerAmount: 0.5, driftAmount: 0, snap: false });
  check("Pitch Center 50% moves a note half way", Math.abs(notes[0].targetCenter - 60.15) < 1e-4, notes[0].targetCenter.toFixed(3));

  notes = make();
  correctPitch(notes, [0], takeSnapshot(notes), { centerAmount: 0, driftAmount: 0.6, snap: false });
  check("Pitch Center 0% leaves the pitch alone but Drift is applied", notes[0].targetCenter === notes[0].center0 && Math.abs(notes[0].drift - 0.6) < 1e-6);

  notes = make();
  const start = takeSnapshot(notes);
  moveNotes(notes, [1], start, 0.4); // hand-edited
  const afterDrag = takeSnapshot(notes);
  correctPitch(notes, [0, 1, 2], afterDrag, { centerAmount: 1, driftAmount: 0, snap: false, includeManual: false });
  check("hand-moved notes are skipped by default", Math.abs(notes[1].targetCenter - 61.8) < 1e-4 && notes[0].targetCenter === 60);

  correctPitch(notes, [0, 1, 2], afterDrag, { centerAmount: 1, driftAmount: 0, snap: false, includeManual: true });
  check("...unless 'Include notes fine-tuned manually' is ticked", notes[1].targetCenter === 62, String(notes[1].targetCenter));

  // running the command again from the same snapshot must give the same answer
  correctPitch(notes, [0, 1, 2], afterDrag, { centerAmount: 1, driftAmount: 0, snap: false, includeManual: true });
  check("running Correct Pitch twice from one snapshot is stable", notes[1].targetCenter === 62 && notes[2].targetCenter === 65);
}

// ---- undo / redo ----
{
  const notes = [makeNote(60, 40), makeNote(64, 40)];
  const history = createHistory();
  check("nothing to undo at first", !history.canUndo() && history.undo(takeSnapshot(notes)) === null);

  const s0 = takeSnapshot(notes);
  history.record(s0); // before edit 1
  moveNotes(notes, [0], s0, 1);
  const s1 = takeSnapshot(notes);
  history.record(s1); // before edit 2
  moveNotes(notes, [1], s1, -2);

  let back = history.undo(takeSnapshot(notes));
  restoreSnapshot(notes, back);
  check("undo reverts the last edit only", notes[0].targetCenter === 61 && notes[1].targetCenter === 64);
  back = history.undo(takeSnapshot(notes));
  restoreSnapshot(notes, back);
  check("undo twice returns to the original", notes[0].targetCenter === 60 && snapshotsEqual(takeSnapshot(notes), s0));
  const forward = history.redo(takeSnapshot(notes));
  restoreSnapshot(notes, forward);
  check("redo re-applies the edit", notes[0].targetCenter === 61);
  history.record(takeSnapshot(notes)); // a brand new edit
  check("a new edit clears the redo list", !history.canRedo());
}

// ---- view: zoom, pan, fit ----
{
  const size = { width: 700, height: 200, duration: 30 };
  const notes = [makeNote(55, 20), makeNote(67, 20)];
  const v = createView();
  fitView(v, notes, size);
  check("fit shows the whole recording", Math.abs(v.pxPerSec * 30 - 700) < 1e-6 && v.t0 === 0);
  check("fit shows every note", yOfMidi(v, 55) < size.height && yOfMidi(v, 55) > 0 && yOfMidi(v, 67) > 0 && yOfMidi(v, 67) < size.height);

  const t = timeOfX(v, 350);
  zoomAt(v, 350, 100, 4, 1, size);
  check("zooming keeps the point under the finger fixed", Math.abs(timeOfX(v, 350) - t) < 1e-6, "t=" + t.toFixed(3) + " -> " + timeOfX(v, 350).toFixed(3));
  check("zoom in made time 4x wider", Math.abs(v.pxPerSec - (700 / 30) * 4) < 1e-6);

  zoomAt(v, 350, 100, 0.001, 1, size);
  check("cannot zoom out further than 'fit'", Math.abs(v.pxPerSec * 30 - 700) < 1e-6);

  v.t0 = 999;
  clampView(v, size);
  check("cannot scroll past the end", v.t0 <= 30);
  v.t0 = -5;
  clampView(v, size);
  check("cannot scroll before the start", v.t0 === 0);

  const m = midiOfY(v, 80);
  check("y <-> note number conversions are inverses", Math.abs(yOfMidi(v, m) - 80) < 1e-9 && Math.abs(xOfTime(v, timeOfX(v, 123)) - 123) < 1e-9);
  check("time lines are never closer than ~64 px", chooseTimeStep(23.3) * 23.3 >= 64 && chooseTimeStep(900) * 900 >= 64);
}

finish();
