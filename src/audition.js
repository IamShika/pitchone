// audition.js
// Plays little pieces of the recording ("auditioning"):
//   playNote   the whole note, at the pitch it is set to
//   scrub      a short slice of the note around a position (follows your finger)
//   pitchPulse a short blip of the note while you drag it up or down
//
// A note you have not edited plays straight from the original recording.
// An edited note is re-created with the pitch shifter (psola.js) first, and the
// result is remembered so pressing it again is instant.

import { isEdited } from "./correct.js";
import { renderNote } from "./psola.js";

const SCRUB_GRAIN = 0.14;       // seconds of sound per scrub slice
const SCRUB_EVERY = 0.04;       // at most one new slice every 40 ms
const PULSE_LENGTH = 0.3;       // seconds of sound per drag blip
const PULSE_EVERY = 0.14;       // at most one blip every 140 ms
const FADE_IN = 0.006;          // short fades so there are no clicks
const FADE_OUT = 0.02;

/**
 * @param {object} deps
 * @param {()=>AudioContext|null} deps.getContext
 * @param {()=>({buffer:AudioBuffer, channels:Float32Array[], mono:Float32Array, hop:number}|null)} deps.getAudio
 *        the recording that is currently open (or null)
 */
export function createAuditioner({ getContext, getAudio }) {
  let voice = null;      // the piece that is sounding right now
  let lastScrub = -1;
  let lastPulse = -1;

  /** The sound to play for a note, and where (in seconds of the recording) that sound starts. */
  function soundFor(note, audio, ctx) {
    if (!isEdited(note)) return { buffer: audio.buffer, startTime: 0 };

    const key = note.targetCenter + "|" + note.drift;
    if (note._audition && note._audition.key === key) return note._audition;

    const piece = renderNote(audio.channels, audio.mono, audio.buffer.sampleRate, note, audio.hop);
    const buffer = ctx.createBuffer(piece.channels.length, piece.channels[0].length, audio.buffer.sampleRate);
    piece.channels.forEach((data, c) => buffer.copyToChannel(data, c));
    note._audition = { key, buffer, startTime: piece.start / audio.buffer.sampleRate };
    return note._audition;
  }

  /** Fade out and stop whatever is sounding. */
  function stop() {
    if (!voice) return;
    const ctx = getContext();
    const now = ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.015);
      voice.source.stop(now + 0.02);
    } catch (e) {
      // already finished
    }
    voice = null;
  }

  /** Play recording-time `from` for `length` seconds of this note's sound. */
  function playPart(note, from, length) {
    const ctx = getContext();
    const audio = getAudio();
    if (!ctx || !audio) return;
    ctx.resume();

    const sound = soundFor(note, audio, ctx);
    const offset = Math.max(0, from - sound.startTime);
    const available = sound.buffer.duration - offset;
    const duration = Math.min(length, available);
    if (duration <= 0.01) return;

    stop(); // the previous piece fades out while the new one fades in

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = sound.buffer;
    source.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    const fadeOut = Math.min(FADE_OUT, duration / 2);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + Math.min(FADE_IN, duration / 2));
    gain.gain.setValueAtTime(1, now + duration - fadeOut);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    source.start(now, offset, duration);

    voice = { source, gain, startedAt: now, recordingTime: from, duration };
  }

  return {
    /** Play the whole note at the pitch it is set to. */
    playNote(note) {
      playPart(note, note.start, note.end - note.start + 0.02);
    },

    /** Play a short slice around `time` (seconds). Call it as the finger moves. */
    scrub(note, time) {
      const ctx = getContext();
      if (!ctx || ctx.currentTime - lastScrub < SCRUB_EVERY) return;
      lastScrub = ctx.currentTime;
      const from = Math.min(Math.max(time, note.start), Math.max(note.start, note.end - 0.05));
      playPart(note, from, Math.min(SCRUB_GRAIN, note.end - from + 0.02));
    },

    /** A short blip of the note, used to hear the new pitch while dragging. */
    pitchPulse(note) {
      const ctx = getContext();
      if (!ctx || ctx.currentTime - lastPulse < PULSE_EVERY) return;
      lastPulse = ctx.currentTime;
      const middle = (note.start + note.end) / 2;
      const from = Math.max(note.start, Math.min(middle - PULSE_LENGTH / 2, note.end - PULSE_LENGTH));
      playPart(note, from, PULSE_LENGTH);
    },

    stop,

    /** The position (in seconds of the recording) that is sounding now, or null when silent. */
    getTime() {
      if (!voice) return null;
      const ctx = getContext();
      const elapsed = ctx.currentTime - voice.startedAt;
      if (elapsed > voice.duration) return null;
      return voice.recordingTime + elapsed;
    },
  };
}
