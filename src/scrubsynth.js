// scrubsynth.js
// The sound engine for "scrubbing": dragging a finger across a note and hearing
// the part under it. (Pure maths, no browser parts, so it can be tested in Node.
// scrub-worklet.js runs it inside the browser's audio thread.)
//
// Why not just play a short slice again and again?
//   That is what the first version did, and it replayed the same 0.1 seconds
//   over and over. Instead this engine plays the sound CONTINUOUSLY, like a
//   tape that follows your finger:
//     - the "play position" chases your finger
//     - finger moving at normal speed -> you hear the note at normal speed
//     - finger slow -> the sound is stretched out slowly, but the PITCH stays
//     - finger fast -> the sound is squeezed, pitch still stays
//     - finger still -> the sound holds for a moment, then fades away
//
// How the pitch stays: the sound is played as lots of short overlapping pieces
// ("grains", 40 ms long, one every 20 ms). Where each piece starts is nudged by
// a few milliseconds so its wave lines up with the end of the previous piece
// (that is called WSOLA). Lined-up waves = no clicks and no "phasey" buzzing.

const GRAIN_SECONDS = 0.04;       // length of one piece
const SEARCH_SECONDS = 0.006;     // how far a piece may be nudged to line up
const CHASE_SECONDS = 0.06;       // how quickly the play position catches up with the finger
const MAX_RATE = 3;               // never play faster than 3x, even if the finger jumps
const HOLD_SECONDS = 0.15;        // how long the sound holds when the finger stops
const FADE_IN_SECONDS = 0.006;
const FADE_OUT_SECONDS = 0.08;

export class ScrubSynth {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.grain = Math.max(8, Math.round(GRAIN_SECONDS * sampleRate) & ~1); // even number of samples
    this.hop = this.grain / 2;
    this.search = Math.round(SEARCH_SECONDS * sampleRate);
    this.window = new Float32Array(this.grain);
    for (let i = 0; i < this.grain; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / this.grain);

    this.channels = [new Float32Array(1)];
    this.accumulator = [new Float32Array(this.grain)];
    this.reset();
  }

  /** Give it the sound to scrub through (one Float32Array per channel). */
  setSource(channels) {
    this.channels = channels.length ? channels : [new Float32Array(1)];
    this.accumulator = this.channels.map(() => new Float32Array(this.grain));
    this.reset();
  }

  reset() {
    this.playing = false;       // is a sound coming out?
    this.position = 0;          // where we are in the source (samples)
    this.target = 0;            // where the finger is (samples)
    this.lastStart = -1;        // where the previous piece was read from
    this.counter = this.hop;    // forces a new piece right away
    this.gain = 0;
    this.stillFor = 0;          // how long the finger has not moved (samples)
    this.fading = false;
    for (const a of this.accumulator) a.fill(0);
  }

  /** The finger is now at `seconds` (measured in the source sound). */
  setTarget(seconds) {
    const sample = seconds * this.sampleRate;
    const limit = Math.max(0, this.channels[0].length - 1);
    const clamped = Math.min(limit, Math.max(0, sample));
    if (!this.playing || this.fading) {
      // start (or restart) from where the finger is
      if (!this.playing) {
        this.position = clamped;
        this.lastStart = -1;
        this.counter = this.hop;
        for (const a of this.accumulator) a.fill(0);
      }
      this.playing = true;
      this.fading = false;
    }
    if (Math.abs(clamped - this.target) > 0.0005 * this.sampleRate) this.stillFor = 0;
    this.target = clamped;
  }

  /** Fade out and go quiet (finger lifted). */
  stop() {
    if (this.playing) this.fading = true;
  }

  /** Where we are in the source, in seconds, or null when silent. */
  getPosition() {
    return this.playing ? this.position / this.sampleRate : null;
  }

  /** Cut the next piece out of the source and add it to the accumulator. */
  makeGrain() {
    const source = this.channels[0];
    const length = source.length;
    const seconds = this.hop / this.sampleRate;

    // 1. move the play position towards the finger
    const error = this.target - this.position;
    const rate = Math.max(-MAX_RATE, Math.min(MAX_RATE, error / this.sampleRate / CHASE_SECONDS));
    this.position += rate * this.hop;
    this.position = Math.min(Math.max(0, this.position), Math.max(0, length - this.grain));
    const finger = Math.abs(this.target - this.position) < 0.01 * this.sampleRate;
    this.stillFor = finger ? this.stillFor + this.hop : 0;
    if (this.stillFor > HOLD_SECONDS * this.sampleRate) this.fading = true;

    // 2. where should this piece start? Nudge it so it lines up with the previous one.
    let start = Math.round(this.position);
    if (this.lastStart >= 0) {
      const natural = this.lastStart + this.hop;   // where the sound would carry on by itself
      const overlap = this.hop;
      if (natural + overlap < length) {
        let best = start, bestScore = -Infinity;
        const low = Math.max(0, start - this.search);
        const high = Math.min(length - this.grain, start + this.search);
        for (let candidate = low; candidate <= high; candidate++) {
          let cross = 0, energy = 0;
          for (let i = 0; i < overlap; i += 2) {
            const a = source[natural + i], b = source[candidate + i];
            cross += a * b; energy += b * b;
          }
          // normalised match; a small pull towards the wanted position breaks ties
          const score = cross / Math.sqrt(energy + 1e-9) - 1e-7 * Math.abs(candidate - start);
          if (score > bestScore) { bestScore = score; best = candidate; }
        }
        start = best;
      }
    }
    start = Math.min(Math.max(0, start), Math.max(0, length - this.grain));
    this.lastStart = start;

    // 3. add the windowed piece
    for (let c = 0; c < this.channels.length; c++) {
      const data = this.channels[c];
      const acc = this.accumulator[c];
      for (let i = 0; i < this.grain; i++) acc[i] += (data[start + i] || 0) * this.window[i];
    }
    return seconds;
  }

  /**
   * Make `frames` samples of sound.
   * @param {Float32Array[]} outputs  one array per output channel (they are overwritten)
   * @param {number} frames
   * @returns {boolean} false once the sound has completely faded away
   */
  process(outputs, frames) {
    for (const out of outputs) out.fill(0, 0, frames);
    if (!this.playing) return false;

    const fadeIn = 1 / (FADE_IN_SECONDS * this.sampleRate);
    const fadeOut = 1 / (FADE_OUT_SECONDS * this.sampleRate);

    for (let n = 0; n < frames; n++) {
      if (this.counter >= this.hop) {
        // a hop has been played: slide the accumulator along and add the next piece
        for (const acc of this.accumulator) {
          acc.copyWithin(0, this.hop);
          acc.fill(0, this.hop);
        }
        this.makeGrain();
        this.counter = 0;
      }
      this.gain = this.fading ? Math.max(0, this.gain - fadeOut) : Math.min(1, this.gain + fadeIn);
      for (let c = 0; c < outputs.length; c++) {
        const acc = this.accumulator[Math.min(c, this.accumulator.length - 1)];
        outputs[c][n] = acc[this.counter] * this.gain;
      }
      this.counter++;
      if (this.fading && this.gain <= 0) {
        this.playing = false;
        this.fading = false;
        this.gain = 0;
        for (const out of outputs) out.fill(0, n + 1, frames);
        return false;
      }
    }
    return true;
  }
}
