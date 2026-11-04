// correctdialog.js
// The "Correct Pitch" window. It only collects the settings; main.js does the
// actual correcting when OK is pressed.
//
// The settings you chose stay in the window, so the next time you open it they
// are still there.

const dialog = document.getElementById("correct-dialog");
const centerSlider = document.getElementById("c-center");
const centerOut = document.getElementById("c-center-out");
const driftSlider = document.getElementById("c-drift");
const driftOut = document.getElementById("c-drift-out");
const snapBox = document.getElementById("c-snap");
const keySelect = document.getElementById("c-key");
const scaleSelect = document.getElementById("c-scale");
const manualBox = document.getElementById("c-manual");
const targetLabel = document.getElementById("c-target");
const okButton = document.getElementById("c-ok");
const cancelButton = document.getElementById("c-cancel");

let onOk = () => {};

// show the numbers next to the sliders
centerSlider.addEventListener("input", () => (centerOut.textContent = centerSlider.value + " %"));
driftSlider.addEventListener("input", () => (driftOut.textContent = driftSlider.value + " %"));

// the key and scale only matter when "Snap to scale" is ticked
function updateScaleControls() {
  keySelect.disabled = !snapBox.checked;
  scaleSelect.disabled = !snapBox.checked;
}
snapBox.addEventListener("change", updateScaleControls);
updateScaleControls();

okButton.addEventListener("click", () => {
  dialog.close();
  onOk({
    centerAmount: Number(centerSlider.value) / 100,
    driftAmount: Number(driftSlider.value) / 100,
    snap: snapBox.checked,
    root: Number(keySelect.value),
    scale: scaleSelect.value,
    includeManual: manualBox.checked,
  });
});
cancelButton.addEventListener("click", () => dialog.close());

/**
 * Open the window.
 * @param {string} description   e.g. "3 selected notes" or "All 12 notes"
 * @param {(options:object)=>void} callback   called with the settings when OK is pressed
 */
export function openCorrectDialog(description, callback) {
  onOk = callback;
  targetLabel.textContent = description;
  dialog.showModal();
}
