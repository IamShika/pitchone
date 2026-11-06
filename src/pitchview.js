// pitchview.js
// The "roll": piano-style note rows in the background, the notes drawn as warm
// gradient BLOBS, the pitch line inside each blob, and a playhead while playing.
//
// Everything here is drawn in CSS pixels (the canvas is scaled for sharp
// phone screens with setTransform). The view (src/view.js) says which part of
// the recording and which notes are on screen.

import { loudnessColor, loudnessOf } from "./heat.js";
import { colors } from "./theme.js";
import { midiToName, isBlackKey } from "./notes.js";
import { editedCurve, isEdited } from "./correct.js";
import { createView, fitView, clampView, xOfTime, timeOfX, yOfMidi, midiOfY, chooseTimeStep } from "./view.js";

// Width of the note-name column on the left, in CSS pixels. main.js reads this
// so the waveform strip lines up with the roll.
export const GUTTER_PX = 44;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function formatTime(seconds, step) {
  if (step < 1) return seconds.toFixed(step < 0.1 ? 2 : 1) + "s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m + ":" + String(s).padStart(2, "0");
}

export function createRoll(canvas) {
  const view = createView();
  let notes = [];
  let refLevel = 1;
  let hop = 0.01;
  let duration = 10;
  let selected = new Set();

  const roll = {
    view,
    userMoved: false, // becomes true once the user zooms or scrolls by hand

    /** Size of the plot area (the roll without the note-name column), in CSS pixels. */
    size() {
      return {
        width: Math.max(1, canvas.clientWidth - GUTTER_PX),
        height: Math.max(1, canvas.clientHeight),
        duration,
      };
    },

    /** Give the roll new notes. */
    setNotes(newNotes, newRefLevel, newHop, newDuration) {
      notes = newNotes;
      refLevel = newRefLevel;
      hop = newHop;
      duration = newDuration;
      selected = new Set();
      roll.fit();
    },

    setSelection(set) {
      selected = set;
    },

    /** Show the whole recording and all notes. */
    fit() {
      fitView(view, notes, roll.size());
      roll.userMoved = false;
    },

    /** Match the canvas's pixel size to its on-screen size (call when the layout changes). */
    resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      if (roll.userMoved) clampView(view, roll.size());
      else roll.fit();
    },

    /** Which note is under this point? (x, y are relative to the canvas.) Returns an index or -1. */
    hitTest(cx, cy) {
      const x = cx - GUTTER_PX;
      if (x < 0) return -1;
      const reach = Math.max(view.rowH * 0.5 + 6, 12); // a bit generous (fingers are not precise), but leave room to scroll
      let best = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (x < xOfTime(view, n.start) - 8 || x > xOfTime(view, n.end) + 8) continue;
        const dy = Math.abs(cy - yOfMidi(view, n.targetCenter));
        if (dy <= reach && dy < bestDistance) {
          best = i;
          bestDistance = dy;
        }
      }
      return best;
    },

    /** Draw everything. `playTime` is the playhead position in seconds, or null. */
    draw(playTime = null) {
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (!cssW || !cssH || !canvas.width) return;

      const c = colors();
      const dpr = canvas.width / cssW;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const plotW = cssW - GUTTER_PX;
      const tLeft = timeOfX(view, 0);
      const tRight = timeOfX(view, plotW);
      const topNote = Math.ceil(midiOfY(view, 0)) + 1;
      const bottomNote = Math.floor(midiOfY(view, cssH)) - 1;

      // ---- the plot area (clipped so nothing spills over the note names) ----
      ctx.save();
      ctx.beginPath();
      ctx.rect(GUTTER_PX, 0, plotW, cssH);
      ctx.clip();
      ctx.translate(GUTTER_PX, 0);

      ctx.fillStyle = c.plotBg;
      ctx.fillRect(0, 0, plotW, cssH);

      // note rows: black piano keys are a little darker
      for (let n = bottomNote; n <= topNote; n++) {
        ctx.fillStyle = isBlackKey(n) ? c.blackRow : c.whiteRow;
        ctx.fillRect(0, yOfMidi(view, n) - view.rowH / 2, plotW, view.rowH + 0.5);
      }
      // lines between rows; the line under every C is stronger (the octave border)
      ctx.lineWidth = 1;
      for (let n = bottomNote; n <= topNote; n++) {
        const y = Math.round(yOfMidi(view, n) + view.rowH / 2) + 0.5;
        ctx.strokeStyle = n % 12 === 0 ? c.octaveLine : c.rowLine;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
        ctx.stroke();
      }

      // time grid
      const step = chooseTimeStep(view.pxPerSec);
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      for (let t = Math.ceil(tLeft / step) * step; t <= tRight; t += step) {
        const x = Math.round(xOfTime(view, t)) + 0.5;
        ctx.strokeStyle = c.timeLine;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
        ctx.stroke();
        ctx.fillStyle = c.label;
        ctx.fillText(formatTime(t, step), x + 4, 3);
      }

      // notes
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (n.end < tLeft || n.start > tRight) continue;
        drawNote(ctx, c, n, selected.has(i));
      }

      if (notes.length === 0) {
        ctx.fillStyle = c.label;
        ctx.font = "14px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Open a vocal recording to see its notes", plotW / 2, cssH / 2);
      }
      ctx.restore();

      // ---- the note-name column ----
      ctx.fillStyle = c.gutter;
      ctx.fillRect(0, 0, GUTTER_PX, cssH);
      ctx.fillStyle = c.label;
      ctx.font = Math.min(11, Math.floor(view.rowH) - 1) + "px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const labelEveryNote = view.rowH >= 10; // rows tall enough: name every note, otherwise just the Cs
      for (let n = bottomNote; n <= topNote; n++) {
        const y = yOfMidi(view, n);
        if (y < 6 || y > cssH - 6) continue;
        if (labelEveryNote || n % 12 === 0) ctx.fillText(midiToName(n), GUTTER_PX - 6, y);
      }

      // ---- playhead ----
      if (playTime !== null) {
        const x = Math.round(GUTTER_PX + xOfTime(view, playTime)) + 0.5;
        if (x >= GUTTER_PX && x <= cssW) {
          ctx.strokeStyle = c.playhead;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, cssH);
          ctx.stroke();
        }
      }
    },
  };

  // ---- drawing one note ----
  function drawNote(ctx, c, note, isSelected) {
    const count = note.midi.length;
    const pxPerFrame = hop * view.pxPerSec;
    const stride = Math.max(1, Math.round(2 / pxPerFrame)); // at least ~2 px between points

    // which frames we draw (always including the last one)
    const frames = [];
    for (let k = 0; k < count; k += stride) frames.push(k);
    if (frames[frames.length - 1] !== count - 1) frames.push(count - 1);

    const xOf = (k) => xOfTime(view, note.start + k * hop);
    const xEnd = xOfTime(view, note.end);
    const yCentre = yOfMidi(view, note.targetCenter);
    const fullThick = Math.max(view.rowH * 0.95, 7);

    // The blob is thicker where the singer is louder, and slightly tapered at both ends.
    const halfThickness = (k) => {
      const loud = clamp(note.level[k] / refLevel, 0, 1.2);
      const body = 0.35 + 0.65 * Math.sqrt(Math.min(loud, 1));
      const taper = Math.min(1, 0.55 + (0.45 * Math.min(k + 1, count - k)) / 4);
      return (fullThick * body * taper) / 2;
    };

    ctx.beginPath();
    ctx.moveTo(xOf(0), yCentre - halfThickness(0));
    for (const k of frames) ctx.lineTo(xOf(k), yCentre - halfThickness(k));
    ctx.lineTo(xEnd, yCentre - halfThickness(count - 1));
    ctx.lineTo(xEnd, yCentre + halfThickness(count - 1));
    for (let j = frames.length - 1; j >= 0; j--) ctx.lineTo(xOf(frames[j]), yCentre + halfThickness(frames[j]));
    ctx.closePath();

    // Colour along the note = loudness: dark red where it is quiet, bright yellow where it is loud.
    const xStart = xOf(0);
    const width = Math.max(1, xEnd - xStart);
    const heat = ctx.createLinearGradient(xStart, 0, xStart + width, 0);
    const colourEvery = Math.max(1, Math.floor(count / 48)); // at most ~48 colour stops
    for (let k = 0; k < count; k += colourEvery) {
      // average a few neighbouring frames so one noisy frame does not flicker
      let sum = 0, n = 0;
      for (let j = Math.max(0, k - 2); j <= Math.min(count - 1, k + 2); j++) { sum += note.level[j]; n++; }
      const stop = Math.min(1, Math.max(0, (xOf(k) - xStart) / width));
      heat.addColorStop(stop, loudnessColor(loudnessOf(sum / n, refLevel)));
    }
    ctx.fillStyle = heat;
    ctx.fill();

    // a little shading across the thickness, so the blob looks round (light in the middle, darker at the edges)
    const shade = ctx.createLinearGradient(0, yCentre - fullThick / 2, 0, yCentre + fullThick / 2);
    shade.addColorStop(0, "rgba(0,0,0,0.28)");
    shade.addColorStop(0.45, "rgba(255,255,255,0.16)");
    shade.addColorStop(0.55, "rgba(255,255,255,0.16)");
    shade.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.blobEdge;
    ctx.stroke();

    // where the note was originally sung (only shown once it has been changed)
    if (isEdited(note)) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = c.ghost;
      ctx.lineWidth = 1;
      ctx.beginPath();
      frames.forEach((k, j) => {
        const x = xOf(k);
        const y = yOfMidi(view, note.midi[k]);
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }

    // the pitch line inside the blob
    const curve = editedCurve(note);
    ctx.strokeStyle = c.curve;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    frames.forEach((k, j) => {
      const x = xOf(k);
      const y = yOfMidi(view, curve[k]);
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // a selected note gets a clear outline box around it
    if (isSelected) {
      const pad = 3;
      ctx.strokeStyle = c.selected;
      ctx.lineWidth = 2;
      ctx.strokeRect(xOf(0) - pad, yCentre - fullThick / 2 - pad, xEnd - xOf(0) + 2 * pad, fullThick + 2 * pad);
    }
  }

  return roll;
}
