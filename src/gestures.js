// gestures.js
// Finger (and mouse) control of the roll.
//
//   tap a note            select it
//   tap empty space       deselect everything (double-tap: show everything)
//   press and hold a note add it to / remove it from the selection
//   drag a note up/down   change its pitch
//   drag empty space      scroll
//   two fingers           pinch to zoom (sideways spread = time, up/down spread = pitch)
//   mouse wheel           zoom time  (Shift + wheel = zoom pitch, sideways wheel = scroll)
//
// This file only works out WHAT the user is doing. What to do about it
// (select, move a note, redraw) is done by the `api` functions main.js passes in.

import { GUTTER_PX } from "./pitchview.js";
import { clampView, zoomAt, pinchTo } from "./view.js";

const SLOP = 6;            // finger must move this many pixels before it counts as a drag
const LONG_PRESS_MS = 450; // how long to hold to add a note to the selection
const DOUBLE_TAP_MS = 350;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} api
 * @param {object} api.roll           the roll from createRoll()
 * @param {()=>Set<number>} api.getSelection
 * @param {(indices:number[])=>void} api.select       replace the selection
 * @param {(index:number)=>void} api.toggle           add/remove one note
 * @param {()=>void} api.clearSelection
 * @param {()=>void} api.beginDrag
 * @param {(semitones:number)=>void} api.dragBy
 * @param {()=>void} api.endDrag
 * @param {()=>void} api.cancelDrag
 * @param {()=>void} api.requestDraw
 * @param {()=>void} api.fit
 */
export function attachGestures(canvas, api) {
  const { roll } = api;
  const view = roll.view;

  const pointers = new Map(); // pointer id -> {x, y} (canvas pixels)
  let single = null;          // the one-finger gesture in progress
  let pinch = null;           // the two-finger gesture in progress
  let lastEmptyTap = { time: 0, x: 0, y: 0 };

  const position = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function startPinch() {
    if (single) {
      clearTimeout(single.timer);
      if (single.mode === "drag") api.cancelDrag();
      single = null;
    }
    const [a, b] = [...pointers.values()];
    pinch = {
      start: { ...view },
      dx: Math.abs(a.x - b.x),
      dy: Math.abs(a.y - b.y),
      from: { x: (a.x + b.x) / 2 - GUTTER_PX, y: (a.y + b.y) / 2 },
    };
  }

  canvas.addEventListener("pointerdown", (e) => {
    try {
      canvas.setPointerCapture(e.pointerId); // keep receiving moves even if the finger leaves the canvas
    } catch (err) {
      // not a real pointer (can happen in tests) - carry on
    }
    pointers.set(e.pointerId, position(e));

    if (pointers.size === 2) return startPinch();
    if (pointers.size > 2) return;

    const p = pointers.get(e.pointerId);
    const hit = roll.hitTest(p.x, p.y);
    single = {
      id: e.pointerId,
      x0: p.x,
      y0: p.y,
      hit,
      mode: "undecided", // becomes "drag" (moving a note) or "pan" (scrolling)
      longPressed: false,
      t0: view.t0,
      midiTop: view.midiTop,
      timer: null,
    };
    if (hit >= 0) {
      single.timer = setTimeout(() => {
        if (single && single.mode === "undecided") {
          single.longPressed = true;
          api.toggle(hit);
        }
      }, LONG_PRESS_MS);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = position(e);
    pointers.set(e.pointerId, p);

    // ---- two fingers: pinch ----
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const clampFactor = (f) => Math.min(6, Math.max(0.16, f));
      // only zoom along an axis if the fingers started far enough apart on it
      const fx = pinch.dx > 30 ? clampFactor(Math.abs(a.x - b.x) / pinch.dx) : 1;
      const fy = pinch.dy > 30 ? clampFactor(Math.abs(a.y - b.y) / pinch.dy) : 1;
      const to = { x: (a.x + b.x) / 2 - GUTTER_PX, y: (a.y + b.y) / 2 };
      pinchTo(view, pinch.start, pinch.from, to, fx, fy, roll.size());
      roll.userMoved = true;
      api.requestDraw();
      return;
    }

    // ---- one finger ----
    if (!single || single.id !== e.pointerId || single.longPressed) return;

    if (single.mode === "undecided") {
      if (Math.hypot(p.x - single.x0, p.y - single.y0) < SLOP) return;
      clearTimeout(single.timer);
      if (single.hit >= 0) {
        single.mode = "drag";
        if (!api.getSelection().has(single.hit)) api.select([single.hit]);
        api.beginDrag();
      } else {
        single.mode = "pan";
      }
    }

    if (single.mode === "drag") {
      api.dragBy(-(p.y - single.y0) / view.rowH); // finger up = pitch up
    } else if (single.mode === "pan") {
      view.t0 = single.t0 - (p.x - single.x0) / view.pxPerSec;
      view.midiTop = single.midiTop + (p.y - single.y0) / view.rowH;
      clampView(view, roll.size());
      roll.userMoved = true;
      api.requestDraw();
    }
  });

  function finish(e, cancelled) {
    pointers.delete(e.pointerId);

    if (pinch) {
      if (pointers.size < 2) pinch = null;
      single = null; // the finger left over after a pinch does nothing
      return;
    }
    if (!single || single.id !== e.pointerId) return;
    clearTimeout(single.timer);

    if (single.mode === "drag") {
      if (cancelled) api.cancelDrag();
      else api.endDrag();
    } else if (single.mode === "undecided" && !single.longPressed && !cancelled) {
      // a tap
      if (single.hit >= 0) {
        api.select([single.hit]);
      } else {
        const now = performance.now();
        const near = Math.hypot(single.x0 - lastEmptyTap.x, single.y0 - lastEmptyTap.y) < 30;
        if (now - lastEmptyTap.time < DOUBLE_TAP_MS && near) {
          api.fit(); // double-tap empty space: show everything
          lastEmptyTap = { time: 0, x: 0, y: 0 };
        } else {
          api.clearSelection();
          lastEmptyTap = { time: now, x: single.x0, y: single.y0 };
        }
      }
    }
    single = null;
  }
  canvas.addEventListener("pointerup", (e) => finish(e, false));
  canvas.addEventListener("pointercancel", (e) => finish(e, true));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- mouse wheel (handy when testing on a computer) ----
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = position(e);
      const ax = p.x - GUTTER_PX;
      const size = roll.size();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        view.t0 += e.deltaX / view.pxPerSec;
        clampView(view, size);
      } else {
        const factor = Math.exp(-e.deltaY * 0.0015);
        if (e.shiftKey) zoomAt(view, ax, p.y, 1, factor, size);
        else zoomAt(view, ax, p.y, factor, 1, size);
      }
      roll.userMoved = true;
      api.requestDraw();
    },
    { passive: false }
  );
}
