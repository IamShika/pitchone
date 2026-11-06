// tests/export.test.js
// Run with:  node tests/export.test.js
//
// Makes WAV / FLAC / MP3 files from a fake voice and checks them. FLAC and MP3 are
// decoded again with ffmpeg (if it is installed) to prove the files are really valid.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav, toInt } from "../src/wav.js";
import { encodeFlac } from "../src/flac.js";
import { encodeMp3 } from "../src/mp3.js";
import { cleanFileName, suggestName } from "../src/exporter.js";
import { makeVoice, singerPitch } from "./voice.js";
import { check, finish } from "./check.js";

const SR = 44100;
const left = makeVoice({ seconds: 2.3, freqAt: singerPitch(180, { seconds: 2.3 }), vowel: "ah", seed: 4 });
const right = Float32Array.from(left, (v, i) => v * 0.6 + 0.02 * Math.sin(i / 7));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const folder = mkdtempSync(join(tmpdir(), "pitchone-"));

/** Decode a file with ffmpeg into 32-bit whole numbers per channel. */
function decode(path, channels) {
  const out = join(folder, "decoded.raw");
  const run = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", path, "-f", "s32le", "-acodec", "pcm_s32le", out]);
  if (run.status !== 0) return { error: String(run.stderr) };
  const raw = readFileSync(out);
  const all = new Int32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const per = [];
  for (let c = 0; c < channels; c++) per.push(Int32Array.from({ length: all.length / channels }, (_, i) => all[i * channels + c]));
  return { channels: per };
}

// ---- WAV ----
for (const bits of [16, 24, 32]) {
  const file = encodeWav([left, right], SR, bits);
  const view = new DataView(file.buffer);
  check("WAV " + bits + "-bit: header says RIFF/WAVE", String.fromCharCode(...file.slice(0, 4)) === "RIFF" && String.fromCharCode(...file.slice(8, 12)) === "WAVE");
  check("WAV " + bits + "-bit: format, channels, rate, bits", view.getUint16(20, true) === (bits === 32 ? 3 : 1) && view.getUint16(22, true) === 2 && view.getUint32(24, true) === SR && view.getUint16(34, true) === bits);
  check("WAV " + bits + "-bit: file size matches", file.length === 44 + left.length * 2 * (bits / 8) && view.getUint32(4, true) === file.length - 8);
  if (hasFfmpeg) {
    const path = join(folder, "t" + bits + ".wav");
    writeFileSync(path, file);
    const decoded = decode(path, 2);
    const scale = 2 ** 31;
    let worst = 0;
    for (let i = 0; i < left.length; i += 97) worst = Math.max(worst, Math.abs(decoded.channels[0][i] / scale - left[i]), Math.abs(decoded.channels[1][i] / scale - right[i]));
    check("WAV " + bits + "-bit: ffmpeg reads it back (error " + worst.toExponential(1) + ")", worst < (bits === 16 ? 1.6e-5 : bits === 24 ? 1e-7 : 1e-9));
  }
}
check("WAV clips too-loud samples instead of wrapping around", toInt(1.5, 16) === 32767 && toInt(-1.5, 16) === -32768);

// ---- FLAC ----
for (const [bits, channels, label] of [[16, [left, right], "stereo 16-bit"], [24, [left, right], "stereo 24-bit"], [16, [left], "mono 16-bit"]]) {
  const file = await encodeFlac(channels, SR, bits);
  check("FLAC " + label + ": starts with fLaC", String.fromCharCode(...file.slice(0, 4)) === "fLaC");
  const wavSize = 44 + left.length * channels.length * (bits / 8);
  check("FLAC " + label + ": smaller than the WAV", file.length < wavSize, (file.length / wavSize * 100).toFixed(0) + "% of the WAV");
  if (hasFfmpeg) {
    const path = join(folder, "t.flac");
    writeFileSync(path, file);
    const decoded = decode(path, channels.length);
    if (decoded.error) { check("FLAC " + label + ": ffmpeg can decode it", false, decoded.error.slice(0, 200)); continue; }
    let same = decoded.channels.length === channels.length && decoded.channels[0].length === left.length;
    // lossless: every sample must come back EXACTLY (ffmpeg gives them as 32-bit numbers)
    channels.forEach((data, c) => {
      for (let i = 0; same && i < data.length; i++) if (decoded.channels[c][i] !== toInt(data[i], bits) * 2 ** (32 - bits)) { same = false; console.log("  first difference at sample", i, c); }
    });
    check("FLAC " + label + ": decodes back to EXACTLY the same samples", same);
  }
}
{
  const silence = await encodeFlac([new Float32Array(10000)], SR, 16);
  check("FLAC: silence compresses to almost nothing", silence.length < 400, silence.length + " bytes");
  if (hasFfmpeg) {
    const path = join(folder, "silence.flac");
    writeFileSync(path, silence);
    const decoded = decode(path, 1);
    check("FLAC: silence decodes to 10000 zeros", !decoded.error && decoded.channels[0].length === 10000 && decoded.channels[0].every((v) => v === 0));
  }
  const loud = Float32Array.from({ length: 9000 }, () => Math.random() * 2 - 1); // noise: hardest case
  const noisy = await encodeFlac([loud], SR, 16);
  if (hasFfmpeg) {
    const path = join(folder, "noise.flac");
    writeFileSync(path, noisy);
    const decoded = decode(path, 1);
    let same = !decoded.error && decoded.channels[0].length === 9000;
    for (let i = 0; same && i < 9000; i++) if (decoded.channels[0][i] !== toInt(loud[i], 16) * 65536) same = false;
    check("FLAC: full-scale noise (the hardest case) is also exact", same);
  }
}

// ---- MP3 ----
{
  const file = await encodeMp3([left, right], SR, 192);
  const seconds = left.length / SR;
  const expected = (192 * 1000 / 8) * seconds;
  check("MP3: size is about what 192 kbps should give", file.length > expected * 0.9 && file.length < expected * 1.15, file.length + " bytes (about " + Math.round(expected) + " expected)");
  if (hasFfmpeg) {
    const path = join(folder, "t.mp3");
    writeFileSync(path, file);
    const decoded = decode(path, 2);
    check("MP3: ffmpeg can decode it", !decoded.error, decoded.error);
    if (!decoded.error) {
      const ratio = decoded.channels[0].length / left.length;
      check("MP3: about the same length as the recording", ratio > 0.97 && ratio < 1.06, "x" + ratio.toFixed(3));
    }
  }
}

// ---- file names ----
check("name: a normal name gets the ending", cleanFileName("My song", "wav") === "My song.wav");
check("name: the ending is not doubled", cleanFileName("My song.MP3", "mp3") === "My song.mp3");
check("name: forbidden characters are removed", cleanFileName('a/b\\c:d*e?f"g<h>i|j', "flac") === "abcdefghij.flac");
check("name: empty becomes a default", cleanFileName("   ", "wav", "recording") === "recording.wav");
check("name: leading dots are removed", cleanFileName("..hidden", "wav") === "hidden.wav");
check("name: very long names are cut", cleanFileName("x".repeat(500), "wav").length <= 124);
check("name: suggestion from the opened file", suggestName("take 3.m4a") === "take 3-edited" && suggestName("") === "recording-edited");

rmSync(folder, { recursive: true, force: true });
if (!hasFfmpeg) console.log("(ffmpeg not installed: the decode-back checks were skipped; the other checks still ran)");
finish();
