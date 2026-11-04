// theme.js
// Two colour schemes: "light" (soft grey, like a classic note editor) and "dark".
// Each theme has page colours (CSS variables) and drawing colours (for the canvases).

const THEMES = {
  light: {
    page: {
      "--bg": "#e3e4e8",
      "--panel": "#f1f1f4",
      "--text": "#1d2130",
      "--muted": "#555b6b",
      "--border": "#b9bcc7",
      "--btn": "#f7f7f9",
      "--btn-hover": "#ffffff",
      "--accent": "#2f55d4",
      "--accent-text": "#ffffff",
      "--dialog": "#dcdde2",
      "--dialog-title": "#c9cad1",
    },
    canvas: {
      plotBg: "#f3f3f5",
      whiteRow: "#f3f3f5",
      blackRow: "#e1e2e6",
      rowLine: "#d0d1d8",
      octaveLine: "#9b9eac",
      timeLine: "#d3d4da",
      gutter: "#d4d5db",
      label: "#4a5060",
      curve: "#6e0f2c",
      ghost: "rgba(60, 64, 80, 0.55)",
      playhead: "#111111",
      blobEdge: "#b3125f",
      blobMid: "#ee5a3a",
      blobCore: "#ffd27a",
      selected: "#1b3aa6",
      waveBg: "#f3f3f5",
      wave: "#8d91a3",
      waveWindow: "rgba(47, 85, 212, 0.18)",
      waveWindowEdge: "#2f55d4",
    },
  },
  dark: {
    page: {
      "--bg": "#14161c",
      "--panel": "#1d2029",
      "--text": "#e8eaf0",
      "--muted": "#9aa0b2",
      "--border": "#3a3f50",
      "--btn": "#262a36",
      "--btn-hover": "#2f3441",
      "--accent": "#7d98ff",
      "--accent-text": "#0d1020",
      "--dialog": "#252936",
      "--dialog-title": "#303545",
    },
    canvas: {
      plotBg: "#1c1f29",
      whiteRow: "#212531",
      blackRow: "#191c25",
      rowLine: "#2c3140",
      octaveLine: "#4f566c",
      timeLine: "#2c3140",
      gutter: "#1d2029",
      label: "#9aa0b2",
      curve: "#ffe9ec",
      ghost: "rgba(200, 205, 225, 0.5)",
      playhead: "#ffffff",
      blobEdge: "#c2185b",
      blobMid: "#f4511e",
      blobCore: "#ffd27a",
      selected: "#ffffff",
      waveBg: "#1d2029",
      wave: "#7d98ff",
      waveWindow: "rgba(125, 152, 255, 0.2)",
      waveWindowEdge: "#7d98ff",
    },
  },
};

let current = "light";

/** The drawing colours of the current theme. */
export function colors() {
  return THEMES[current].canvas;
}

export function themeName() {
  return current;
}

/** Switch theme: updates the page colours and remembers the choice. */
export function setTheme(name) {
  if (!THEMES[name]) name = "light";
  current = name;
  const root = document.documentElement;
  root.dataset.theme = name;
  for (const [variable, value] of Object.entries(THEMES[name].page)) {
    root.style.setProperty(variable, value);
  }
  try {
    localStorage.setItem("pitchone-theme", name);
  } catch (e) {
    // private mode etc. - not important
  }
}

/** Call once at start: restores the theme the user picked last time. */
export function loadTheme() {
  let saved = "light";
  try {
    saved = localStorage.getItem("pitchone-theme") || "light";
  } catch (e) {
    // ignore
  }
  setTheme(saved);
}
