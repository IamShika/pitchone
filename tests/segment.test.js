// tests/segment.test.js
// Run with:  node tests/segment.test.js
//
// We build fake pitch tracks (what a singer would produce) and check that
// buildNotes() finds the right notes.

import { buildNotes } from "../src/segment.js";
import { midiToFreq } from "../src/notes.js";
import { analyzePitch } from "../src/pitch.js";
import { check, finish } from "./check.js";

const HOP = 0.01; // 10 ms per reading, same as the real analysis

/**
 * Describe a performance as pieces, get back a pitch track.
 *   { midi: 60, frames: 60 }                      a steady note
 *   { rest: 20 }                                  silence
 *   { midi: (i) => 60 + Math.sin(i / 3), frames } a note whose pitch is a function of the frame
 */
function makeTrack(pieces) {
  const values = [];
  const levels = [];
  for (const p of pieces) {
    for (let i = 0; i < (p.frames ?? p.rest); i++) {
      if (p.rest) values.push(NaN);
      else values.push(typeof p.midi === "function" ? p.midi(i) : p.midi);
      levels.push(p.level ? p.level(i) : p.rest ? 0 : 0.2); // optional loudness per frame (silence by default for rests)
    }
  }
  const freqs = new Float32Array(values.map((m) => (Number.isNaN(m) ? 0 : midiToFreq(m))));
  return { hop: HOP, freqs, level: Float32Array.from(levels), duration: freqs.length * HOP };
}

const vibrato = (centre, depth, hz = 5.5) => (i) => centre + depth * Math.sin(2 * Math.PI * hz * i * HOP);

// ---- 1. separate notes with silence between them ----
{
  const { notes } = buildNotes(makeTrack([
    { rest: 10 }, { midi: 60, frames: 60 }, { rest: 15 }, { midi: 64, frames: 60 }, { rest: 15 }, { midi: 67, frames: 60 }, { rest: 10 },
  ]));
  const centres = notes.map((n) => n.center0.toFixed(2)).join(", ");
  check("three notes separated by silence", notes.length === 3 && notes.every((n, i) => Math.abs(n.center0 - [60, 64, 67][i]) < 0.05), centres);
}

// ---- 2. notes sung without a gap (legato) ----
{
  const { notes } = buildNotes(makeTrack([
    { midi: 60, frames: 50 }, { midi: 62, frames: 50 }, { midi: 64, frames: 50 }, { midi: 62, frames: 50 },
  ]));
  const cuts = notes.slice(1).map((n) => n.startFrame);
  const ok = notes.length === 4 && [50, 100, 150].every((c, i) => Math.abs(cuts[i] - c) <= 3);
  check("four legato notes are split at the pitch steps", ok, "cuts at frames " + cuts.join(", "));
}

// ---- 3. vibrato must not split a note ----
for (const depth of [0.3, 0.5, 0.8]) {
  const { notes } = buildNotes(makeTrack([{ midi: vibrato(65, depth), frames: 150 }]));
  check(
    "vibrato +/-" + depth + " semitone stays ONE note",
    notes.length === 1 && Math.abs(notes[0].center0 - 65) < 0.1,
    notes.length + " note(s), centre " + (notes[0] ? notes[0].center0.toFixed(2) : "-")
  );
}
{
  // vibrato on both sides of a real step
  const { notes } = buildNotes(makeTrack([
    { midi: vibrato(60, 0.5), frames: 100 }, { midi: vibrato(63, 0.5), frames: 100 },
  ]));
  check("vibrato + a real step gives exactly two notes", notes.length === 2, notes.length + " notes");
}

// ---- 4. glitches are ignored ----
{
  const spiky = makeTrack([{ midi: 62, frames: 120 }]);
  for (const at of [20, 50, 51, 80]) spiky.freqs[at] = midiToFreq(74); // octave jumps, 1-2 readings
  spiky.freqs[100] = 0; // one dropped reading
  const { notes } = buildNotes(spiky);
  check("octave glitches and a dropped reading do not break a note", notes.length === 1 && Math.abs(notes[0].center0 - 62) < 0.05, notes.length + " note(s)");
}
{
  const blip = makeTrack([{ rest: 20 }, { midi: 60, frames: 3 }, { rest: 20 }, { midi: 64, frames: 60 }]);
  const { notes } = buildNotes(blip);
  check("a 30 ms blip is not a note", notes.length === 1 && Math.abs(notes[0].center0 - 64) < 0.05, notes.length + " note(s)");
}

// ---- 4b. glitches at the edges of a note must not leave spikes in its pitch line ----
{
  const { notes } = buildNotes(makeTrack([{ midi: 67, frames: 6 }, { midi: 62, frames: 60 }, { midi: 66, frames: 6 }]));
  const worst = Math.max(...notes.flatMap((n) => Array.from(n.midi).map((m) => Math.abs(m - n.center0))));
  check("short glitches at the start/end of a note are repaired", notes.length === 1 && worst <= 1.5 + 1e-6, notes.length + " note(s), worst wander " + worst.toFixed(2));
}

// ---- 5. short gaps are bridged, long gaps split ----
{
  const bridged = buildNotes(makeTrack([{ midi: 60, frames: 50 }, { rest: 2, level: () => 0.2 }, { midi: 60, frames: 50 }])).notes; // pitch detector dropped out, but the sound continued
  check("a 20 ms dropout inside a note is bridged", bridged.length === 1);
  const split = buildNotes(makeTrack([{ midi: 60, frames: 50 }, { rest: 6 }, { midi: 60, frames: 50 }])).notes;
  check("a 60 ms silence between same-pitch notes splits them", split.length === 2);
}

// ---- 5b. repeated notes on the same pitch ("la la la"): the volume dips between them ----
{
  // loud, then a 6-frame dip to 10% loudness at the join, then loud again - all on the same pitch
  const repeated = buildNotes(makeTrack([
    { midi: 62, frames: 60, level: (i) => (i >= 57 ? 0.02 : 0.2) },
    { midi: 62, frames: 60, level: (i) => (i < 3 ? 0.02 : 0.2) },
  ])).notes;
  check("same-pitch notes with a volume dip between them are split", repeated.length === 2, repeated.length + " notes");

  const oneDip = buildNotes(makeTrack([{ midi: 62, frames: 120, level: (i) => (i >= 57 && i < 63 ? 0.02 : 0.2) }])).notes;
  check("a single dip in one held note splits it into two", oneDip.length === 2, oneDip.length + " notes");

  // gentle tremolo (20% volume wobble, 6 times a second) must not split a held note
  const tremolo = buildNotes(makeTrack([{ midi: 62, frames: 200, level: (i) => 0.2 * (1 + 0.2 * Math.sin(2 * Math.PI * 6 * i * HOP)) }])).notes;
  check("gentle tremolo does not split a note", tremolo.length === 1, tremolo.length + " notes");

  // a note that fades in and out (loudness shape) is one note
  const swell = buildNotes(makeTrack([{ midi: 62, frames: 150, level: (i) => 0.05 + 0.2 * Math.sin((Math.PI * i) / 150) }])).notes;
  check("a note that swells and fades is one note", swell.length === 1, swell.length + " notes");
}

// ---- 6. slides and leaps ----
{
  // a one-octave slide over 2 s becomes a staircase of short notes that go up and cover everything
  const slide = buildNotes(makeTrack([{ midi: (i) => 60 + 12 * (i / 200), frames: 200 }])).notes;
  const rising = slide.every((n, i) => i === 0 || n.center0 > slide[i - 1].center0);
  const joined = slide.every((n, i) => i === 0 || n.startFrame === slide[i - 1].endFrame);
  check("a long slide becomes a rising staircase of notes", slide.length >= 4 && rising && joined, slide.length + " notes");

  const leap = buildNotes(makeTrack([{ midi: 60, frames: 60 }, { midi: 72, frames: 60 }])).notes;
  check("an instant octave leap is two notes", leap.length === 2);

  // a quick 100 ms portamento between two held notes should NOT create extra notes
  const porta = buildNotes(makeTrack([
    { midi: 60, frames: 60 }, { midi: (i) => 60 + 4 * (i / 10), frames: 10 }, { midi: 64, frames: 60 },
  ])).notes;
  check("a quick slide between two notes still gives two notes", porta.length === 2, porta.length + " notes");
}

// ---- 6b. realistic wobble: vibrato + jitter, notes only one semitone apart ----
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const wobbly = (frames, centre) => (i) => centre + 0.5 * Math.sin(2 * Math.PI * 5.8 * i * HOP) + 0.12 * rnd();
  const { notes } = buildNotes(makeTrack([
    { midi: wobbly(60, 60), frames: 60 }, { midi: wobbly(60, 61), frames: 60 }, { midi: wobbly(60, 62), frames: 60 },
    { midi: wobbly(60, 61), frames: 60 }, { midi: wobbly(60, 59), frames: 60 },
  ]));
  check("five notes one semitone apart, with vibrato and jitter", notes.length === 5, notes.map((n) => n.center0.toFixed(1)).join(" "));
}

// ---- 7. out of tune notes keep their real pitch ----
{
  const { notes } = buildNotes(makeTrack([{ midi: 67 - 0.35, frames: 80 }]));
  check("a note sung 35 cents flat is measured as 35 cents flat", Math.abs(notes[0].center0 - 66.65) < 0.03, notes[0].center0.toFixed(3));
}

// ---- 8. the whole pipeline with real audio: sound -> pitch -> notes ----
{
  const SR = 44100;
  const melody = [[60, 0.5], [64, 0.5], [67, 0.5], [72, 0.7]];
  const gap = 0.08;
  const samples = [];
  let phase = 0;
  for (const [midi, seconds] of melody) {
    const f = midiToFreq(midi);
    for (let i = 0; i < seconds * SR; i++) {
      phase += (2 * Math.PI * f) / SR;
      let v = 0;
      for (let k = 1; k <= 8; k++) v += Math.sin(k * phase) / k;
      const t = i / SR;
      const envelope = Math.min(1, t / 0.02, (seconds - t) / 0.02); // short fade in / out
      samples.push(v * 0.25 * envelope);
    }
    for (let i = 0; i < gap * SR; i++) samples.push(0);
  }
  const data = Float32Array.from(samples);
  const buffer = { sampleRate: SR, length: data.length, numberOfChannels: 1, duration: data.length / SR, getChannelData: () => data };
  const track = await analyzePitch(buffer);
  const { notes } = buildNotes(track);
  const ok = notes.length === 4 && notes.every((n, i) => Math.abs(n.center0 - melody[i][0]) < 0.05);
  check("audio of C4 E4 G4 C5 becomes four notes", ok, notes.map((n) => n.center0.toFixed(2)).join(", "));
  check("every note has loudness data", notes.every((n) => n.level.length === n.midi.length && n.level[5] > 0));
}

finish();
