// notes.js
// Small helpers for talking about pitch the way musicians do.
//
// MIDI note numbers count semitones: 60 = middle C (C4), 69 = A4 = 440 Hz.
// Every +12 is one octave up (which doubles the frequency).

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = [1, 3, 6, 8, 10]; // C#, D#, F#, G#, A#

/** Frequency in Hz -> MIDI note number (can have decimals, 69.5 = 50 cents above A4). */
export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

/** MIDI note number -> frequency in Hz. */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Note name of the nearest semitone, like "A4" or "C#3". */
export function midiToName(midi) {
  const n = Math.round(midi);
  return NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

/** Is this semitone a black piano key? */
export function isBlackKey(midi) {
  return BLACK_KEYS.includes(((midi % 12) + 12) % 12);
}

/** How far a pitch is from its nearest note, in cents (100 cents = 1 semitone). */
export function centsOff(midi) {
  return Math.round((midi - Math.round(midi)) * 100);
}
