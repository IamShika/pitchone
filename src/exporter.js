// exporter.js
// Everything about saving the result as a file, except the window itself:
// the list of formats, cleaning up the file name, and making the file.

import { encodeWav } from "./wav.js";
import { encodeFlac } from "./flac.js";
import { encodeMp3 } from "./mp3.js";

/** The formats offered in the Export window. */
export const FORMATS = {
  wav: {
    label: "WAV",
    extension: "wav",
    mime: "audio/wav",
    note: "Exact copy of the sound. Big files (about 10 MB per minute).",
    options: [
      { value: "16", label: "16-bit (CD quality)" },
      { value: "24", label: "24-bit (studio)" },
      { value: "32", label: "32-bit float (no rounding at all)" },
    ],
    defaultOption: "16",
  },
  flac: {
    label: "FLAC",
    extension: "flac",
    mime: "audio/flac",
    note: "Exact copy of the sound, but about half the size of WAV.",
    options: [
      { value: "16", label: "16-bit (CD quality)" },
      { value: "24", label: "24-bit (studio)" },
    ],
    defaultOption: "16",
  },
  mp3: {
    label: "MP3",
    extension: "mp3",
    mime: "audio/mpeg",
    note: "Small files (about 1.4 MB per minute at 192 kbps) that play everywhere. Not an exact copy.",
    options: [
      { value: "128", label: "128 kbps (small)" },
      { value: "192", label: "192 kbps (good)" },
      { value: "256", label: "256 kbps (very good)" },
      { value: "320", label: "320 kbps (best)" },
    ],
    defaultOption: "192",
  },
};

/**
 * Make a safe file name: no characters that file systems dislike, no dots at the
 * start, not too long, and always the right ending for the format.
 * @param {string} name   what the person typed (may be empty)
 * @param {string} extension  "wav", "flac" or "mp3" (without the dot)
 * @param {string} fallback   used when the name is empty
 */
export function cleanFileName(name, extension, fallback = "pitchone") {
  let base = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")   // characters Windows and Android do not allow
    .replace(/\s+/g, " ")
    .trim();
  // if the person typed the ending themselves ("song.mp3"), do not add it twice
  base = base.replace(new RegExp("\\." + extension + "$", "i"), "").replace(/^\.+/, "").trim();
  if (!base) base = fallback;
  if (base.length > 120) base = base.slice(0, 120).trim();
  return base + "." + extension;
}

/** The name suggested at first: the opened file's name + "-edited". */
export function suggestName(originalFileName) {
  const base = String(originalFileName || "").replace(/\.[^.]*$/, "").trim();
  return (base || "recording") + "-edited";
}

/**
 * Make the file.
 * @param {"wav"|"flac"|"mp3"} format
 * @param {string} option      one of FORMATS[format].options values
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function makeFile(format, option, channels, sampleRate, onProgress) {
  const info = FORMATS[format];
  let bytes;
  if (format === "wav") bytes = encodeWav(channels, sampleRate, Number(option));
  else if (format === "flac") bytes = await encodeFlac(channels, sampleRate, Number(option), onProgress);
  else if (format === "mp3") bytes = await encodeMp3(channels, sampleRate, Number(option), onProgress);
  else throw new Error("Unknown format " + format);
  if (onProgress) onProgress(1);
  return new Blob([bytes], { type: info.mime });
}
