// exportdialog.js
// The Export window: choose a file name, a format (WAV / FLAC / MP3) and its
// quality, then save the file.
//
// This file only handles the window and the download. The actual file making is
// in exporter.js (and wav.js, flac.js, mp3.js).

import { FORMATS, cleanFileName, makeFile } from "./exporter.js";

const dialog = document.getElementById("export-dialog");
const nameInput = document.getElementById("x-name");
const extLabel = document.getElementById("x-ext");
const segments = [...dialog.querySelectorAll(".seg")];
const optionSelect = document.getElementById("x-option");
const optionLabel = document.getElementById("x-option-label");
const noteEl = document.getElementById("x-note");
const progress = document.getElementById("x-progress");
const message = document.getElementById("x-message");
const okButton = document.getElementById("x-ok");
const cancelButton = document.getElementById("x-cancel");

let format = "wav";
let working = false;
let job = null; // { getAudio, sampleRate } for the window that is open

// what the person chose last time (the window remembers it while the app is open)
const chosen = { wav: FORMATS.wav.defaultOption, flac: FORMATS.flac.defaultOption, mp3: FORMATS.mp3.defaultOption };

function showFormat(next) {
  format = next;
  const info = FORMATS[format];
  segments.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.format === format)));
  extLabel.textContent = "." + info.extension;
  optionLabel.textContent = format === "mp3" ? "Bit rate" : "Bit depth";
  optionSelect.replaceChildren(
    ...info.options.map((o) => {
      const element = document.createElement("option");
      element.value = o.value;
      element.textContent = o.label;
      return element;
    })
  );
  optionSelect.value = chosen[format];
  noteEl.textContent = info.note;
}

segments.forEach((b) => b.addEventListener("click", () => !working && showFormat(b.dataset.format)));
optionSelect.addEventListener("change", () => (chosen[format] = optionSelect.value));

/** Hand the file to the browser as a download. */
function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function setWorking(on) {
  working = on;
  okButton.disabled = on;
  cancelButton.textContent = on ? "Close" : "Cancel";
  nameInput.disabled = on;
  optionSelect.disabled = on;
  progress.hidden = !on;
  if (!on) progress.value = 0;
}

okButton.addEventListener("click", async () => {
  if (working || !job) return;
  const fileName = cleanFileName(nameInput.value, FORMATS[format].extension);
  nameInput.value = fileName.replace(/\.[^.]+$/, ""); // show the cleaned name
  setWorking(true);
  try {
    message.textContent = "Preparing your edited sound ...";
    const audio = await job.getAudio();
    message.textContent = "Making " + FORMATS[format].label + " ...";
    const blob = await makeFile(format, optionSelect.value, audio.channels, audio.sampleRate, (f) => (progress.value = f));
    download(blob, fileName);
    message.textContent = "Saved " + fileName + " (" + (blob.size / 1048576).toFixed(1) + " MB)";
    job.onDone(fileName);
  } catch (error) {
    console.error(error);
    message.textContent = "Could not make the file: " + (error && error.message ? error.message : error);
  } finally {
    setWorking(false);
  }
});

cancelButton.addEventListener("click", () => {
  // closing while a file is being made does not stop it, but nothing else is touched
  dialog.close();
});

/**
 * Open the window.
 * @param {object} o
 * @param {string} o.name        the file name to start with (no ending)
 * @param {()=>Promise<{channels:Float32Array[], sampleRate:number}>} o.getAudio   the sound to save (with all edits)
 * @param {(fileName:string)=>void} [o.onDone]   called after the file was handed over
 */
export function openExportDialog({ name, getAudio, onDone = () => {} }) {
  job = { getAudio, onDone };
  nameInput.value = name;
  message.textContent = "";
  showFormat(format);
  setWorking(false);
  dialog.showModal();
}
