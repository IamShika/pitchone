// main.js
// Wires everything together:
//   open a file -> decode -> find the pitch -> cut it into notes -> show blobs
//   tap / drag / zoom the notes, Correct Pitch, undo, play.
//
// You can edit the pitch of notes on screen, and you hear the result:
//   press a note        -> plays that note at the pitch it is set to
//   drag across a note  -> plays the part under your finger
//   Play                -> plays the whole recording with your edits (or the original if there are none)

import { computePeaks, drawWaveform } from "./waveform.js";
import { analyzePitch, frameAt } from "./pitch.js";
import { buildNotes } from "./segment.js";
import { createRoll, GUTTER_PX } from "./pitchview.js";
import { attachGestures } from "./gestures.js";
import { clampView, zoomAt } from "./view.js";
import { freqToMidi, midiToName, centsOff } from "./notes.js";
import { takeSnapshot, restoreSnapshot, snapshotsEqual, moveNotes, correctPitch, isEdited, editedCurve } from "./correct.js";
import { createAuditioner } from "./audition.js";
import { mixToMono, renderEdited } from "./psola.js";
import { createHistory } from "./history.js";
import { openCorrectDialog } from "./correctdialog.js";
import { openExportDialog } from "./exportdialog.js";
import { suggestName } from "./exporter.js";
import { loadTheme, setTheme, themeName } from "./theme.js";

// ---- the things on the page ----
const $ = (id) => document.getElementById(id);
const fileInput = $("file");
const waveCanvas = $("wave");
const pitchCanvas = $("pitch");
const statusEl = $("status");
const readoutEl = $("readout");
const playBtn = $("play");
const correctBtn = $("correct");
const exportBtn = $("export");
const undoBtn = $("undo");
const redoBtn = $("redo");
const zoomInBtn = $("zoom-in");
const zoomOutBtn = $("zoom-out");
const fitBtn = $("fit");
const themeBtn = $("theme");
const fullBtn = $("full");

loadTheme();
document.documentElement.style.setProperty("--gutter", GUTTER_PX + "px");

const roll = createRoll(pitchCanvas);
const view = roll.view;
const history = createHistory();

// ---- app state (the things that change while the app runs) ----
let audioCtx = null;      // the Web Audio "engine" (created on the first tap)
let audioBuffer = null;   // the decoded audio data
let peaks = null;         // squeezed waveform for drawing
let track = null;         // raw pitch readings from pitch.js
let notes = [];           // the notes (blobs) from segment.js
let selected = new Set(); // indices of selected notes
let source = null;        // the node that is currently playing (or null)
let startedAt = 0;        // audioCtx.currentTime minus the position we started from
let animationId = 0;      // handle for the playback animation loop
let loadId = 0;           // bumps on every new file, so old analyses can be cancelled
let dragStart = null;     // snapshot taken when a drag begins
let dragHit = -1;         // the note being dragged
let drawQueued = false;
let preparing = false;     // true while the edited sound is being made
let channels = [];        // the original audio, one array per channel
let mono = null;          // the same audio mixed to one channel
let editedCache = { key: "", buffer: null }; // the recording with all edits applied (remembered)
let fileName = "";         // name of the opened file (suggests the export name)
let idleStatus = "Open a vocal recording to start."; // what the status line says when nothing is playing

const audition = createAuditioner({
  getContext: () => audioCtx,
  getAudio: () => (audioBuffer && track ? { buffer: audioBuffer, channels, mono, hop: track.hop } : null),
});

const setStatus = (text) => (statusEl.textContent = text);
function setIdleStatus(text) {
  idleStatus = text;
  setStatus(text);
}

// ---- drawing ----
function playTime() {
  if (source) return audioCtx.currentTime - startedAt;
  return audition.getTime(); // a pressed note is sounding (or null)
}

// While a note is sounding, keep redrawing so the playhead moves.
let auditionLoopRunning = false;
function startAuditionLoop() {
  if (auditionLoopRunning) return;
  auditionLoopRunning = true;
  const step = () => {
    if (source || audition.getTime() === null) {
      auditionLoopRunning = false;
      redraw(); // clears the playhead
      return;
    }
    redraw();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function redraw() {
  const t = playTime();
  roll.draw(t);

  // the overview strip: whole recording + a box for what the roll shows
  let visible = null;
  if (audioBuffer) {
    const seconds = roll.size().width / view.pxPerSec;
    visible = { from: view.t0 / audioBuffer.duration, to: (view.t0 + seconds) / audioBuffer.duration };
  }
  drawWaveform(waveCanvas, peaks, t === null || !audioBuffer ? null : t / audioBuffer.duration, visible);
}

/** Ask for a redraw soon (several requests in one moment become one redraw). */
function requestDraw() {
  if (drawQueued || source) return; // while playing, tick() redraws anyway
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    redraw();
  });
}

function sizeCanvases() {
  roll.resize();
  const dpr = window.devicePixelRatio || 1;
  waveCanvas.width = Math.floor(waveCanvas.clientWidth * dpr);
  waveCanvas.height = Math.floor(waveCanvas.clientHeight * dpr);
  if (audioBuffer) peaks = computePeaks(audioBuffer, waveCanvas.width);
  redraw();
}

function updateButtons() {
  const hasNotes = notes.length > 0;
  playBtn.disabled = !audioBuffer;
  playBtn.textContent = source ? "Stop" : "Play";
  correctBtn.disabled = !hasNotes;
  exportBtn.disabled = !audioBuffer || preparing;
  zoomInBtn.disabled = !hasNotes;
  zoomOutBtn.disabled = !hasNotes;
  fitBtn.disabled = !hasNotes;
  undoBtn.disabled = !history.canUndo();
  redoBtn.disabled = !history.canRedo();
}

// ---- the "A4 +12c" display ----
function describePitch(midi) {
  const cents = centsOff(midi);
  return midiToName(midi) + " " + (cents > 0 ? "+" : "") + cents + "c";
}

function showSelectionReadout() {
  if (selected.size === 1) {
    readoutEl.textContent = describePitch(notes[[...selected][0]].targetCenter);
  } else if (selected.size > 1) {
    readoutEl.textContent = selected.size + " notes";
  } else {
    readoutEl.textContent = "--";
  }
}

function showPlaybackReadout(seconds) {
  if (!track) return;
  // inside an edited note we are playing the NEW pitch, so show that
  const note = notes.find((n) => seconds >= n.start && seconds < n.end);
  if (note && isEdited(note)) {
    const k = Math.min(note.midi.length - 1, Math.max(0, Math.floor((seconds - note.start) / track.hop)));
    readoutEl.textContent = describePitch(editedCurve(note)[k]);
    return;
  }
  const freq = track.freqs[frameAt(track, seconds)];
  readoutEl.textContent = freq > 0 ? describePitch(freqToMidi(freq)) : "--";
}

// ---- selecting and dragging notes (called by gestures.js) ----
function setSelection(indices) {
  selected = new Set(indices);
  roll.setSelection(selected);
  if (!source) showSelectionReadout();
  requestDraw();
}

const gestureApi = {
  roll,
  getSelection: () => selected,
  select: (indices) => setSelection(indices),
  toggle: (index) => {
    const next = new Set(selected);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setSelection([...next]);
  },
  clearSelection: () => setSelection([]),

  // a note was pressed: play it (at the pitch it is set to)
  press(index) {
    if (source) stop(); // the main playback and a note preview should not play together
    audition.playNote(notes[index]);
    startAuditionLoop();
  },
  // the finger moves sideways across a note: play the part under it
  scrub(index, seconds) {
    audition.scrub(notes[index], seconds);
    startAuditionLoop();
  },
  stopAudition() {
    audition.stop();
  },

  beginDrag(index) {
    dragStart = takeSnapshot(notes);
    dragHit = index;
  },
  dragBy(semitones) {
    moveNotes(notes, [...selected], dragStart, semitones);
    if (!source) showSelectionReadout();
    audition.pitchPulse(notes[dragHit]); // a short blip so you hear the new pitch while dragging
    startAuditionLoop();
    requestDraw();
  },
  endDrag() {
    const changed = notes.some((n, i) => Math.abs(n.targetCenter - dragStart[i].targetCenter) > 1e-6);
    if (changed) {
      history.record(dragStart);
      audition.playNote(notes[dragHit]); // let go: hear the whole note at its new pitch
      startAuditionLoop();
    } else {
      restoreSnapshot(notes, dragStart);
    }
    dragStart = null;
    updateButtons();
    requestDraw();
  },
  cancelDrag() {
    if (dragStart) restoreSnapshot(notes, dragStart);
    dragStart = null;
    audition.stop();
    if (!source) showSelectionReadout();
    requestDraw();
  },

  requestDraw,
  fit() {
    roll.fit();
    requestDraw();
  },
};
attachGestures(pitchCanvas, gestureApi);

// ---- opening a file ----
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;

  const myLoad = ++loadId; // if the user opens another file, this number becomes stale
  fileName = file.name;
  stop();
  audition.stop();
  editedCache = { key: "", buffer: null };
  track = null;
  notes = [];
  selected = new Set();
  history.clear();
  roll.setNotes([], 1, 0.01, audioBuffer ? audioBuffer.duration : 10);
  readoutEl.textContent = "--";
  setIdleStatus("Reading " + file.name + " ...");
  updateButtons();

  try {
    // Browsers only allow audio to start after a user tap, so we create
    // the AudioContext here (inside a tap handler).
    audioCtx = audioCtx || new AudioContext();
    audition.prepare(); // load the smooth scrubber in the background

    const bytes = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(bytes);
    if (myLoad !== loadId) return;

    channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, c) => audioBuffer.getChannelData(c));
    mono = mixToMono(channels);
    peaks = computePeaks(audioBuffer, waveCanvas.width);
    roll.setNotes([], 1, 0.01, audioBuffer.duration);
    updateButtons();
    redraw();

    // find the pitch (a few seconds for a long recording)
    const name = file.name;
    setIdleStatus("Analysing pitch ... 0%");
    track = await analyzePitch(audioBuffer, {
      onProgress: (fraction) => {
        if (myLoad === loadId) setIdleStatus("Analysing pitch ... " + Math.round(fraction * 100) + "%");
      },
      isCancelled: () => myLoad !== loadId,
    });
    if (!track || myLoad !== loadId) return;

    // cut it into notes
    const result = buildNotes(track);
    notes = result.notes;
    roll.setNotes(notes, result.refLevel, track.hop, track.duration);
    updateButtons();
    redraw();

    const seconds = audioBuffer.duration.toFixed(1);
    if (notes.length === 0) {
      setIdleStatus(seconds + " s - no clear notes found. Is this a recording of a voice?");
    } else {
      setIdleStatus(seconds + " s - " + notes.length + " notes - press a note to hear it, Play plays your edits - " + name);
    }
  } catch (error) {
    console.error(error);
    audioBuffer = null;
    peaks = null;
    track = null;
    notes = [];
    roll.setNotes([], 1, 0.01, 10);
    updateButtons();
    redraw();
    setIdleStatus("Could not read that file. Try a .wav or .mp3.");
  }
});

// ---- Correct Pitch, undo, redo ----
correctBtn.addEventListener("click", () => {
  if (notes.length === 0) return;
  const description = selected.size
    ? selected.size + " selected note" + (selected.size === 1 ? "" : "s")
    : "All " + notes.length + " notes";

  openCorrectDialog(description, (options) => {
    const indices = selected.size ? [...selected] : notes.map((_, i) => i);
    const before = takeSnapshot(notes);
    correctPitch(notes, indices, before, options);
    if (!snapshotsEqual(before, takeSnapshot(notes))) history.record(before);
    if (!source) showSelectionReadout();
    updateButtons();
    requestDraw();
  });
});

// ---- Export ----
exportBtn.addEventListener("click", () => {
  if (!audioBuffer) return;
  stop();
  audition.stop();
  openExportDialog({
    name: suggestName(fileName),
    // the recording with all edits applied (the original if nothing was changed)
    getAudio: async () => {
      const playable = await getPlayableBuffer();
      const out = [];
      for (let c = 0; c < playable.buffer.numberOfChannels; c++) out.push(playable.buffer.getChannelData(c));
      return { channels: out, sampleRate: playable.buffer.sampleRate };
    },
    onDone: () => setStatus(idleStatus),
  });
});

function undo() {
  const previous = history.undo(takeSnapshot(notes));
  if (previous) restoreSnapshot(notes, previous);
  afterHistoryMove();
}
function redo() {
  const next = history.redo(takeSnapshot(notes));
  if (next) restoreSnapshot(notes, next);
  afterHistoryMove();
}
function afterHistoryMove() {
  if (!source) showSelectionReadout();
  updateButtons();
  requestDraw();
}
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

// handy on a computer: Ctrl+Z / Ctrl+Shift+Z / Space
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (e.key === " " && audioBuffer && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    togglePlay();
  }
});

// ---- zoom buttons ----
function zoomBy(factor) {
  const size = roll.size();
  zoomAt(view, size.width / 2, size.height / 2, factor, factor, size);
  roll.userMoved = true;
  requestDraw();
}
zoomInBtn.addEventListener("click", () => zoomBy(1.6));
zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.6));
fitBtn.addEventListener("click", () => gestureApi.fit());

// ---- the overview strip: tap or drag to jump around ----
function jumpTo(e) {
  if (!audioBuffer) return;
  const rect = waveCanvas.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const size = roll.size();
  view.t0 = fraction * audioBuffer.duration - size.width / view.pxPerSec / 2; // centre the view there
  clampView(view, size);
  roll.userMoved = true;
  requestDraw();
}
waveCanvas.addEventListener("pointerdown", (e) => {
  waveCanvas.setPointerCapture(e.pointerId);
  jumpTo(e);
});
waveCanvas.addEventListener("pointermove", (e) => {
  if (waveCanvas.hasPointerCapture(e.pointerId)) jumpTo(e);
});

// ---- playback ----

/** What to play: the original, or (if any note was edited) the recording with all edits applied. */
async function getPlayableBuffer() {
  if (!notes.some(isEdited)) return { buffer: audioBuffer, edited: false };

  const key = notes.map((n) => n.targetCenter.toFixed(4) + "|" + n.drift.toFixed(3)).join(",");
  if (editedCache.key !== key) {
    setStatus("Preparing your edited sound ...");
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the screen show that message first

    const out = renderEdited(channels, audioBuffer.sampleRate, notes, track.hop);
    const buffer = audioCtx.createBuffer(out.length, out[0].length, audioBuffer.sampleRate);
    out.forEach((data, c) => buffer.copyToChannel(data, c));
    editedCache = { key, buffer };
  }
  return { buffer: editedCache.buffer, edited: true };
}

async function play() {
  if (!audioBuffer || preparing) return;
  stop();
  audition.stop();

  // start at the selected note, or at the left edge of what you are looking at
  let offset = view.t0;
  if (selected.size > 0) offset = Math.max(0, notes[Math.min(...selected)].start - 0.3);
  offset = Math.min(offset, Math.max(0, audioBuffer.duration - 0.05));

  preparing = true;
  let playable;
  try {
    playable = await getPlayableBuffer();
  } finally {
    preparing = false;
  }

  audioCtx.resume();
  source = audioCtx.createBufferSource();
  source.buffer = playable.buffer;
  source.connect(audioCtx.destination);
  source.onended = stop; // when the audio ends by itself, clean up
  source.start(0, offset);
  startedAt = audioCtx.currentTime - offset;

  setStatus(playable.edited ? "Playing your EDITED version" : "Playing the original (you have not changed any notes yet)");
  updateButtons();
  tick();
}

function stop() {
  if (source) {
    source.onended = null; // avoid calling stop() twice
    try {
      source.stop();
    } catch (e) {
      // already stopped - nothing to do
    }
    source.disconnect();
    source = null;
  }
  cancelAnimationFrame(animationId);
  setStatus(idleStatus);
  showSelectionReadout();
  updateButtons();
  redraw();
}

function togglePlay() {
  if (source) stop();
  else play();
}

// Runs about 60 times per second while playing.
function tick() {
  if (!source) return;
  const t = audioCtx.currentTime - startedAt;

  // scroll along with the music when the playhead reaches the right edge
  const seconds = roll.size().width / view.pxPerSec;
  if (t < view.t0 || t > view.t0 + seconds * 0.92) {
    view.t0 = t - seconds * 0.08;
    clampView(view, roll.size());
  }

  redraw();
  showPlaybackReadout(t);
  animationId = requestAnimationFrame(tick);
}

playBtn.addEventListener("click", togglePlay);

// ---- theme and full screen ----
themeBtn.addEventListener("click", () => {
  setTheme(themeName() === "light" ? "dark" : "light");
  redraw();
});

if (document.documentElement.requestFullscreen) {
  fullBtn.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
        // on a phone, also lock to sideways while in full screen
        if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape");
      }
    } catch (e) {
      // not allowed here - ignore
    }
  });
} else {
  fullBtn.hidden = true;
}

// A peek inside the app, handy for tests and for exploring in the browser console.
window.pitchone = { roll, audition, getNotes: () => notes, getSelection: () => [...selected] };

// ---- start ----
// Redraw whenever the roll or the overview change size (rotating the phone,
// entering full screen, ...).
new ResizeObserver(sizeCanvases).observe(pitchCanvas);
new ResizeObserver(sizeCanvases).observe(waveCanvas);
sizeCanvases();
updateButtons();
