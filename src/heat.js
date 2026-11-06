// heat.js
// Turns loudness into a colour for the blobs:
//   quiet = dark red,  louder = red, orange,  loud = bright yellow
// (like a heat map: the "hotter" the colour, the louder the singer).

// loudness (0 = silent ... 1 = the loudest the recording gets) -> colour
const STOPS = [
  [0.0, [77, 7, 16]],     // very dark red
  [0.25, [163, 18, 28]],  // dark red
  [0.5, [232, 72, 26]],   // orange-red
  [0.75, [255, 179, 0]],  // orange-yellow
  [1.0, [255, 243, 92]],  // bright yellow
];

/** Colour for a loudness between 0 and 1, as [red, green, blue] (0..255). */
export function loudnessRgb(loudness) {
  const t = Math.min(1, Math.max(0, loudness));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, a] = STOPS[i - 1];
      const [t1, b] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return a.map((v, k) => Math.round(v + (b[k] - v) * f));
    }
  }
  return STOPS[STOPS.length - 1][1].slice();
}

/** The same colour as a CSS string. */
export function loudnessColor(loudness) {
  const [r, g, b] = loudnessRgb(loudness);
  return "rgb(" + r + "," + g + "," + b + ")";
}

/**
 * How loud a frame is, 0..1, as the eye should see it. The level is raised to the
 * power 0.75 (a gentle version of the square root) because we hear loudness
 * roughly that way: it spreads the quiet end out a little, but keeps soft
 * parts clearly dark red.
 */
export function loudnessOf(level, referenceLevel) {
  if (!(referenceLevel > 0)) return 0;
  return Math.pow(Math.min(1, Math.max(0, level / referenceLevel)), 0.75);
}
