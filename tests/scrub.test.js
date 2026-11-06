// tests/scrub.test.js
// Run with:  node tests/scrub.test.js
//
// Tests the scrubbing engine (scrubsynth.js): we "drag a finger" across a fake
// voice at different speeds and measure what comes out.

import { ScrubSynth } from "../src/scrubsynth.js";
import { analyzePitch } from "../src/pitch.js";
import { makeVoice, singerPitch } from "./voice.js";
import { periodicity, rmsOf } from "./metrics.js";
import { freqToMidi } from "../src/notes.js";
import { check, finish } from "./check.js";

const SR = 44100;
const BLOCK = 128; // the browser asks for sound 128 samples at a time
const fake = (d) => ({ sampleRate: SR, length: d.length, numberOfChannels: 1, duration: d.length / SR, getChannelData: () => d });

const voice = makeVoice({ seconds: 4, freqAt: singerPitch(200, { seconds: 4, vibratoSemitones: 0.4, vibratoHz: 5.5 }), vowel: "ah", seed: 2 });
const medianMidi = async (data) => {
  const track = await analyzePitch(fake(data));
  const values = Array.from(track.freqs).filter((f) => f > 0).map(freqToMidi).sort((a, b) => a - b);
  return values[values.length >> 1];
};

/**
 * Drag the finger from `from` seconds at `speed` (1 = as fast as the sound itself)
 * for `seconds`, and record what comes out. `positions` is where the engine was, block by block.
 */
function drag(synth, from, speed, seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  const positions = [];
  const block = [new Float32Array(BLOCK)];
  for (let i = 0; i + BLOCK <= out.length; i += BLOCK) {
    synth.setTarget(from + (speed * i) / SR);
    synth.process(block, BLOCK);
    out.set(block[0], i);
    positions.push(synth.getPosition());
  }
  return { out, positions };
}

function makeSynth() {
  const synth = new ScrubSynth(SR);
  synth.setSource([voice]);
  return synth;
}

// ---- 1. finger at normal speed: sounds like the original, same pitch ----
{
  const { out } = drag(makeSynth(), 0.5, 1, 1.5);
  const sourcePitch = await medianMidi(voice.slice(Math.round(0.5 * SR), Math.round(2 * SR)));
  const pitch = await medianMidi(out.slice(Math.round(0.2 * SR)));
  check("normal speed: same pitch as the source", Math.abs(pitch - sourcePitch) < 0.2, (pitch - sourcePitch).toFixed(2) + " semitones off");
  const steady = periodicity(out, SR, 0.2, 1.4);
  check("normal speed: a clean, steady tone", steady.mean > 0.9, steady.mean.toFixed(3));
  const db = 20 * Math.log10(rmsOf(out, Math.round(0.3 * SR), Math.round(1.4 * SR)) / rmsOf(voice, Math.round(0.8 * SR), Math.round(1.9 * SR)));
  check("normal speed: as loud as the source", Math.abs(db) < 1.5, db.toFixed(2) + " dB");
}

// ---- 2. slow finger: the sound is stretched, but the pitch does NOT drop ----
{
  const synth = makeSynth();
  const { out, positions } = drag(synth, 0.5, 0.3, 1.5);
  const sourcePitch = await medianMidi(voice.slice(Math.round(0.5 * SR), Math.round(1.2 * SR)));
  const pitch = await medianMidi(out.slice(Math.round(0.2 * SR)));
  check("slow finger: pitch stays the same (not a slowed-down tape)", Math.abs(pitch - sourcePitch) < 0.3, (pitch - sourcePitch).toFixed(2) + " semitones off");
  const moved = positions[positions.length - 1] - positions[Math.round(positions.length / 3)];
  const expected = 0.3 * 1.0; // the last two thirds = 1 s at 0.3x
  check("slow finger: the sound moves along at the finger's speed", Math.abs(moved - expected) < 0.08, moved.toFixed(2) + " s (wanted about " + expected + " s)");
  check("slow finger: still a clean tone", periodicity(out, SR, 0.2, 1.4).mean > 0.88);
}

// ---- 3. it never goes back and replays: the position only moves forward ----
{
  const { positions } = drag(makeSynth(), 0.5, 0.4, 2);
  let backwards = 0;
  for (let i = 1; i < positions.length; i++) if (positions[i] < positions[i - 1] - 1e-6) backwards++;
  check("moving forward: the play position never jumps back", backwards === 0, backwards + " backwards steps");
}

// ---- 4. finger moving backwards works too ----
{
  const { out, positions } = drag(makeSynth(), 2.5, -0.5, 1.5);
  check("moving backwards: the position goes down", positions[positions.length - 1] < positions[Math.round(positions.length / 3)] - 0.2);
  check("moving backwards: no broken numbers in the sound", out.every(Number.isFinite));
  check("moving backwards: it is audible", rmsOf(out, Math.round(0.3 * SR), out.length) > 0.01);
}

// ---- 5. finger stops: the sound holds a moment, then fades to silence ----
{
  const synth = makeSynth();
  const moving = drag(synth, 0.5, 1, 0.4);
  const block = [new Float32Array(BLOCK)];
  const tail = [];
  for (let i = 0; i < Math.round(0.8 * SR); i += BLOCK) {
    synth.process(block, BLOCK);
    tail.push(...block[0]);
  }
  const tailData = Float32Array.from(tail);
  check("finger still: sound is still there right after it stops", rmsOf(tailData, 0, Math.round(0.05 * SR)) > 0.02);
  check("finger still: silent after half a second", rmsOf(tailData, Math.round(0.6 * SR), tailData.length) < 1e-4, rmsOf(tailData, Math.round(0.6 * SR), tailData.length).toExponential(1));
  check("finger still: the engine reports it is finished", synth.getPosition() === null);
  check("finger still: it did not loop the same bit as a stutter", periodicity(tailData, SR, 0.0, 0.14).mean > 0.8);
}

// ---- 6. finger lifted: fades out quickly without a click ----
{
  const synth = makeSynth();
  drag(synth, 0.5, 1, 0.4);
  synth.stop();
  const block = [new Float32Array(BLOCK)];
  let biggestStep = 0, last = null, silentAfter = -1;
  for (let i = 0; i < Math.round(0.3 * SR); i += BLOCK) {
    const alive = synth.process(block, BLOCK);
    for (const v of block[0]) { if (last !== null) biggestStep = Math.max(biggestStep, Math.abs(v - last)); last = v; }
    if (!alive && silentAfter < 0) silentAfter = i / SR;
  }
  check("lifting the finger fades out within 0.15 s", silentAfter > 0 && silentAfter < 0.15, silentAfter.toFixed(3) + " s");
  check("...without a click (no step bigger than the voice itself has)", biggestStep < 0.05, biggestStep.toFixed(3));
}

// ---- 7. a finger that jumps far does not make a wild sound ----
{
  const synth = makeSynth();
  const block = [new Float32Array(BLOCK)];
  synth.setTarget(0.5);
  let peak = 0;
  for (let i = 0; i < 300; i++) {
    if (i === 100) synth.setTarget(3.0); // a big jump
    synth.process(block, BLOCK);
    for (const v of block[0]) peak = Math.max(peak, Math.abs(v));
  }
  check("a big jump stays at a sensible volume", peak < 0.6, "peak " + peak.toFixed(2));
}

// ---- 8. stereo ----
{
  const synth = new ScrubSynth(SR);
  synth.setSource([voice, Float32Array.from(voice, (v) => v * 0.5)]);
  const blocks = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  let left = 0, right = 0;
  for (let i = 0; i < 400; i++) {
    synth.setTarget(0.5 + (i * BLOCK) / SR);
    synth.process(blocks, BLOCK);
    if (i > 50) for (let n = 0; n < BLOCK; n++) { left += blocks[0][n] ** 2; right += blocks[1][n] ** 2; }
  }
  check("stereo: the quieter side stays half as loud", Math.abs(Math.sqrt(right / left) - 0.5) < 0.03, Math.sqrt(right / left).toFixed(3));
}

finish();
