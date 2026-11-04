// pitchview.js
// Draws the "piano roll": note rows in the background, the detected pitch
// curve on top, and a white playhead line while the audio plays.

import { freqToMidi, midiToName, isBlackKey } from "./notes.js";

// Width of the note-name column on the left, in CSS pixels. main.js reads this
// so the waveform underneath lines up exactly with the pitch curve above.
export const GUTTER_PX = 44;

const COLORS = {
  gutter: "#1d2029",
  whiteRow: "#232734",
  blackRow: "#1a1d27",
  rowLine: "#2c3140",
  octaveLine: "#4a5166",
  timeLine: "#2c3140",
  label: "#8b90a0",
  curve: "#6c8cff",
  playhead: "#ffffff",
};

// If the pitch jumps more than this many semitones in 10 ms, don't connect the
// dots with a line (it is probably a detection glitch, not real singing).
const MAX_JUMP = 2.5;

/** Which range of notes should the roll show? */
function chooseRange(midis) {
  if (midis.length === 0) return [48, 72]; // C3 to C5 when there is nothing yet

  // Ignore the most extreme 1% so one glitch can't squash the whole view.
  const sorted = Float32Array.from(midis).sort();
  const low = sorted[Math.floor(sorted.length * 0.01)];
  const high = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];

  let lo = Math.floor(low) - 1;
  let hi = Math.ceil(high) + 1;

  // Always show at least one octave so the rows don't get huge.
  while (hi - lo + 1 < 13) {
    lo--;
    if (hi - lo + 1 < 13) hi++;
  }
  return [lo, hi];
}

/** Pick a spacing for the vertical time lines so they are not too crowded. */
function chooseTimeStep(pixelsPerSecond) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of steps) {
    if (step * pixelsPerSecond >= 70) return step;
  }
  return steps[steps.length - 1];
}

function formatTime(seconds, step) {
  if (step < 1) return seconds.toFixed(1) + "s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + ":" + String(s).padStart(2, "0");
}

/**
 * Create a pitch view for a <canvas>.
 *
 * The background and the curve never change while the audio plays, so we paint
 * them ONCE into a hidden canvas ("layer"). Each animation frame then only
 * copies that picture and adds the playhead line. That keeps playback smooth.
 */
export function createPitchView(canvas) {
  let track = null;
  let layer = null; // the cached background + curve

  function buildLayer() {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = canvas.clientWidth > 0 ? w / canvas.clientWidth : 1;

    layer = document.createElement("canvas");
    layer.width = w;
    layer.height = h;
    const ctx = layer.getContext("2d");

    const gutter = Math.round(GUTTER_PX * dpr);
    const plotW = w - gutter;
    const duration = track ? track.duration : 10;

    // Work out which notes are shown
    const midis = [];
    if (track) {
      for (let i = 0; i < track.freqs.length; i++) {
        if (track.freqs[i] > 0) midis.push(freqToMidi(track.freqs[i]));
      }
    }
    const [lo, hi] = chooseRange(midis);
    const rows = hi - lo + 1;
    const rowH = h / rows;
    const yOfNote = (midi) => h - (midi - lo + 0.5) * rowH; // centre of that note's row

    // 1. Note rows (black keys are a bit darker, like a piano roll)
    ctx.font = Math.round(11 * dpr) + "px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let n = lo; n <= hi; n++) {
      const top = h - (n - lo + 1) * rowH;
      ctx.fillStyle = isBlackKey(n) ? COLORS.blackRow : COLORS.whiteRow;
      ctx.fillRect(gutter, top, plotW, rowH);
    }
    // ...then the lines between rows (drawn second so the fills never cover them)
    for (let n = lo; n <= hi; n++) {
      const top = Math.round(h - (n - lo + 1) * rowH) + 0.5;
      ctx.strokeStyle = n % 12 === 0 ? COLORS.octaveLine : COLORS.rowLine;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(gutter, top);
      ctx.lineTo(w, top);
      ctx.stroke();
    }

    // 2. Time grid
    const pxPerSec = plotW / duration; // device pixels per second
    const step = chooseTimeStep(pxPerSec / dpr); // the helper wants CSS pixels
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let t = 0; t <= duration; t += step) {
      const x = Math.round(gutter + t * pxPerSec) + 0.5;
      ctx.strokeStyle = COLORS.timeLine;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.fillText(formatTime(t, step), x + 4 * dpr, 3 * dpr);
    }

    // 3. Note-name column on the left. Show every note if the rows are tall
    //    enough to read, otherwise only the C of each octave.
    ctx.fillStyle = COLORS.gutter;
    ctx.fillRect(0, 0, gutter, h);
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const labelEveryNote = rowH / dpr >= 15;
    for (let n = lo; n <= hi; n++) {
      if (labelEveryNote || n % 12 === 0) {
        ctx.fillText(midiToName(n), gutter - 6 * dpr, yOfNote(n));
      }
    }

    // 4. The pitch curve
    if (track) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(gutter, 0, plotW, h); // never draw over the note names
      ctx.clip();

      ctx.strokeStyle = COLORS.curve;
      ctx.lineWidth = 2.5 * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();

      let previous = null; // MIDI value of the last voiced reading, or null after a gap
      for (let i = 0; i < track.freqs.length; i++) {
        const freq = track.freqs[i];
        if (freq <= 0) {
          previous = null; // unvoiced: break the line
          continue;
        }
        const midi = freqToMidi(freq);
        const x = gutter + i * track.hop * pxPerSec;
        const y = yOfNote(midi);

        if (previous === null || Math.abs(midi - previous) > MAX_JUMP) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.01, y); // a tiny dot, so a lone reading is still visible
        } else {
          ctx.lineTo(x, y);
        }
        previous = midi;
      }
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = COLORS.label;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = Math.round(14 * dpr) + "px system-ui, sans-serif";
      ctx.fillText("Open a vocal recording to see its pitch", gutter + plotW / 2, h / 2);
    }
  }

  return {
    /** Give the view a new pitch track (or null to clear it). */
    setTrack(newTrack) {
      track = newTrack;
      layer = null;
    },

    /** Call after the canvas size changed. */
    invalidate() {
      layer = null;
    },

    /** Paint. `playhead` is 0..1 along the recording, or null to hide it. */
    draw(playhead = null) {
      if (canvas.width === 0 || canvas.height === 0) return;
      if (!layer) buildLayer();

      const ctx = canvas.getContext("2d");
      ctx.drawImage(layer, 0, 0);

      if (playhead !== null) {
        const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
        const gutter = Math.round(GUTTER_PX * dpr);
        const x = Math.round(gutter + playhead * (canvas.width - gutter)) + 0.5;
        ctx.strokeStyle = COLORS.playhead;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
    },
  };
}
