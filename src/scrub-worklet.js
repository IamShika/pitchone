// scrub-worklet.js
// Runs the scrubbing engine (scrubsynth.js) inside the browser's audio thread, so
// the sound is smooth even while the screen is busy drawing.
// audition.js sends it messages:
//   { type: "source", channels: [Float32Array, ...] }   the sound to scrub through
//   { type: "target", seconds }                          where the finger is
//   { type: "stop" }                                     finger lifted: fade out
// and it reports back { position } (seconds in the source) about every 20 ms.

import { ScrubSynth } from "./scrubsynth.js";

class ScrubProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.synth = new ScrubSynth(sampleRate); // `sampleRate` is provided by the audio thread
    this.sinceReport = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "source") this.synth.setSource(message.channels);
      else if (message.type === "target") this.synth.setTarget(message.seconds);
      else if (message.type === "stop") this.synth.stop();
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;
    const alive = this.synth.process(output, frames);
    this.sinceReport += frames;
    if (this.sinceReport > 0.02 * sampleRate) {
      this.sinceReport = 0;
      this.port.postMessage({ position: alive ? this.synth.getPosition() : null });
    }
    return true; // stay alive so we can be used again
  }
}

registerProcessor("pitchone-scrub", ScrubProcessor);
