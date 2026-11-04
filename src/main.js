// main.js
// Stage 2: open an audio file -> draw the waveform -> find the pitch over time
// -> draw the pitch curve on a piano roll -> play / stop with a moving playhead.

import { computePeaks, drawWaveform } from "./waveform.js";
import { analyzePitch, frameAt } from "./pitch.js";
import { createPitchView, GUTTER_PX } from "./pitchview.js";
import { freqToMidi, midiToName, centsOff } from "./notes.js";

// ---- grab the things we need from the page ----
const fileInput = document.getElementById("file");
const waveCanvas = document.getElementById("wave");
const pitchCanvas = document.getElementById("pitch");
const statusEl = document.getElementById("status");
const readoutEl = document.getElementById("readout");
const playBtn = document.getElementById("play");
const stopBtn = document.getElementById("stop");

const pitchView = createPitchView(pitchCanvas);

// Tell the stylesheet how wide the note-name column is (keeps both canvases aligned).
document.documentElement.style.setProperty("--gutter", GUTTER_PX + "px");

// ---- app state (the things that change while the app runs) ----
let audioCtx = null;     // the Web Audio "engine" (created on first tap)
let audioBuffer = null;  // the decoded audio data
let peaks = null;        // squeezed waveform for drawing
let track = null;        // the pitch track from pitch.js (null until analysed)
let source = null;       // the node that is currently playing (or null)
let startedAt = 0;       // audioCtx.currentTime when playback started
let animationId = 0;     // handle for the playhead animation loop
let loadId = 0;          // bumps on every new file, so old analyses can be cancelled

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- drawing ----
function redraw(playhead = null) {
  drawWaveform(waveCanvas, peaks, playhead);
  pitchView.draw(playhead);
}

// Make the canvases sharp on high-DPI phone screens.
function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
}

function resizeCanvases() {
  sizeCanvas(waveCanvas);
  sizeCanvas(pitchCanvas);
  pitchView.invalidate();
  if (audioBuffer) {
    peaks = computePeaks(audioBuffer, waveCanvas.width);
  }
  redraw();
}

// ---- the "A4 +12c" display ----
function showReadout(seconds) {
  if (!track) {
    readoutEl.textContent = "--";
    return;
  }
  const freq = track.freqs[frameAt(track, seconds)];
  if (freq <= 0) {
    readoutEl.textContent = "--";
    return;
  }
  const midi = freqToMidi(freq);
  const cents = centsOff(midi);
  const sign = cents > 0 ? "+" : "";
  readoutEl.textContent = midiToName(midi) + " " + sign + cents + "c";
}

// ---- opening a file ----
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;

  const myLoad = ++loadId; // if the user opens another file, this number becomes stale
  stop();
  track = null;
  pitchView.setTrack(null);
  readoutEl.textContent = "--";
  setStatus("Reading " + file.name + " ...");

  try {
    // Browsers only allow audio to start after a user tap, so we create
    // the AudioContext here (inside a tap handler).
    audioCtx = audioCtx || new AudioContext();

    const bytes = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(bytes);
    if (myLoad !== loadId) return;

    peaks = computePeaks(audioBuffer, waveCanvas.width);
    redraw();
    playBtn.disabled = false;
    stopBtn.disabled = false;

    const seconds = audioBuffer.duration.toFixed(1);
    const name = file.name;

    // Now find the pitch. This takes a few seconds for a long recording.
    setStatus(name + " - analysing pitch ... 0%");
    track = await analyzePitch(audioBuffer, {
      onProgress: (fraction) => {
        if (myLoad === loadId) {
          setStatus(name + " - analysing pitch ... " + Math.round(fraction * 100) + "%");
        }
      },
      isCancelled: () => myLoad !== loadId,
    });
    if (!track || myLoad !== loadId) return;

    pitchView.setTrack(track);
    redraw();

    const voiced = track.freqs.filter((f) => f > 0).length;
    const percent = Math.round((voiced / track.freqs.length) * 100);
    // (the file name goes last, so if the text is too long for the screen only the name gets cut)
    setStatus(seconds + " s - pitch found in " + percent + "% - " + name);
  } catch (error) {
    console.error(error);
    audioBuffer = null;
    peaks = null;
    track = null;
    pitchView.setTrack(null);
    redraw();
    playBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus("Could not read that file. Try a .wav or .mp3.");
  }
});

// ---- playback ----
function play() {
  if (!audioBuffer) return;
  stop();

  audioCtx.resume();
  source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);
  source.onended = stop; // when the audio ends by itself, clean up
  source.start();

  startedAt = audioCtx.currentTime;
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
  readoutEl.textContent = "--";
  redraw();
}

// Runs about 60 times per second while playing; moves the white playhead line.
function tick() {
  if (!source) return;
  const elapsed = audioCtx.currentTime - startedAt;
  redraw(Math.min(elapsed / audioBuffer.duration, 1));
  showReadout(elapsed);
  animationId = requestAnimationFrame(tick);
}

playBtn.addEventListener("click", play);
stopBtn.addEventListener("click", stop);
window.addEventListener("resize", resizeCanvases);

// ---- start ----
resizeCanvases();
