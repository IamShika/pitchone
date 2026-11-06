// tests/heat.test.js - the loudness colours: dark red = quiet, bright yellow = loud
import { loudnessRgb, loudnessOf } from "../src/heat.js";
import { check, finish } from "./check.js";

const brightness = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;
const quiet = loudnessRgb(0), loud = loudnessRgb(1);
check("quiet is dark red", quiet[0] > quiet[1] * 3 && quiet[0] < 120, quiet.join(","));
check("loud is bright yellow (lots of red AND green, little blue)", loud[0] > 230 && loud[1] > 200 && loud[2] < 130, loud.join(","));
let ok = true;
for (let t = 0.01; t <= 1; t += 0.01) if (brightness(loudnessRgb(t)) < brightness(loudnessRgb(t - 0.01)) - 1e-9) ok = false;
check("the louder, the brighter (never gets darker)", ok);
const mid = loudnessRgb(0.5);
check("in between is orange/red (more red than green)", mid[0] > mid[1] && mid[1] > 30, mid.join(","));
check("out-of-range values are clamped", loudnessRgb(-3).join() === quiet.join() && loudnessRgb(9).join() === loud.join());
check("loudness 0..1 from a level", Math.abs(loudnessOf(0.25, 1) - 0.354) < 0.01 && loudnessOf(2, 1) === 1 && loudnessOf(1, 0) === 0);
const soft = loudnessRgb(loudnessOf(0.25, 1));
check("a quarter as loud as the loudest part still looks dark red", soft[0] > 120 && soft[0] < 220 && soft[1] < 50, soft.join(","));
finish();
