// main.js
// Stage 1: pick an audio file -> decode it -> draw the waveform -> play / stop.

import { computePeaks, drawWaveform } from "./waveform.js";

// ---- grab the things we need from the page ----
const fileInput = document.getElementById("file");
const canvas = document.getElementById("wave");
const statusEl = document.getElementById("status");
const playBtn = document.getElementById("play");
const stopBtn = document.getElementById("stop");

// ---- app state (the things that change while the app runs) ----
let audioCtx = null;     // the Web Audio "engine" (created on first tap)
let audioBuffer = null;  // the decoded audio data
let peaks = null;        // squeezed waveform for drawing
let source = null;       // the node that is currently playing (or null)
let startedAt = 0;       // audioCtx.currentTime when playback started
let animationId = 0;     // handle for the playhead animation loop

function setStatus(text) {
  statusEl.textContent = text;
}

// ---- drawing ----
function redraw(playhead = null) {
  drawWaveform(canvas, peaks, playhead);
}

// Make the canvas sharp on high-DPI phone screens.
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  if (audioBuffer) {
    peaks = computePeaks(audioBuffer, canvas.width);
  }
  redraw();
}

// ---- loading a file ----
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;

  stop();
  setStatus("Reading " + file.name + " ...");

  try {
    // Browsers only allow audio to start after a user tap, so we create
    // the AudioContext here (inside a tap handler).
    audioCtx = audioCtx || new AudioContext();

    const bytes = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(bytes);

    peaks = computePeaks(audioBuffer, canvas.width);
    redraw();

    const seconds = audioBuffer.duration.toFixed(1);
    setStatus(file.name + " - " + seconds + " s, " + audioBuffer.sampleRate + " Hz");
    playBtn.disabled = false;
    stopBtn.disabled = false;
  } catch (error) {
    console.error(error);
    audioBuffer = null;
    peaks = null;
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
  redraw();
}

// Runs about 60 times per second while playing; moves the white playhead line.
function tick() {
  if (!source) return;
  const elapsed = audioCtx.currentTime - startedAt;
  redraw(Math.min(elapsed / audioBuffer.duration, 1));
  animationId = requestAnimationFrame(tick);
}

playBtn.addEventListener("click", play);
stopBtn.addEventListener("click", stop);
window.addEventListener("resize", resizeCanvas);

// ---- start ----
resizeCanvas();
