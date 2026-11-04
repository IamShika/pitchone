# PitchBlob

An open-source, phone-friendly **vocal pitch editor**, inspired by note-based editors like Melodyne. It is built from scratch with plain HTML + JavaScript so it can be written and tested on a phone using only Termux.

> PitchBlob is an independent hobby project. It is not affiliated with or endorsed by Celemony or Melodyne.

## Goal

Singers who only have a phone should be able to fix the pitch of a recorded vocal:

1. Load or record a vocal.
2. See each sung note as a "blob" on a piano roll.
3. Drag a blob up or down to correct its pitch.
4. Listen to the result and export it.

Scope: **single voice (monophonic) only**. Chords and polyphonic editing are out of scope.

## Status

| Stage | What it does | Done |
|-------|--------------|------|
| 1 | Load an audio file, draw the waveform, play / stop | yes |
| 2 | Detect pitch over time (YIN algorithm) and draw the pitch curve | |
| 3 | Split the pitch curve into notes and draw them as blobs on a piano roll | |
| 4 | Drag blobs to change their pitch (data only, no sound yet) | |
| 5 | Re-synthesize the audio with the new pitches (PSOLA) | |
| 6 | Record from the microphone | |
| 7 | Export the result as a WAV file | |
| 8 | Package as an Android APK with GitHub Actions (Capacitor) | |

## Run it on your phone (Termux)

```bash
pkg install python
cd pitchblob
python -m http.server 8000
```

Then open **http://localhost:8000** in your phone's browser (Chrome or Firefox).

Why a server? The code uses JavaScript modules, which browsers refuse to load when you open `index.html` directly as a file.

## Project layout

```
pitchblob/
  index.html        the page
  style.css         how it looks
  src/
    main.js         wires the page together (load file, play, stop)
    waveform.js     computes and draws the waveform
```

## Publish it on GitHub from Termux

Create an empty repository on github.com first (no README, no license), then:

```bash
pkg install git
git config --global user.name "Your Name"
git config --global user.email "you@example.com"

cd pitchblob
git init
git add .
git commit -m "Stage 1: load audio and draw waveform"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pitchblob.git
git push -u origin main
```

### Free hosting with GitHub Pages

On GitHub: **Settings > Pages > Deploy from a branch > main > / (root)**. After a minute the app is live at `https://YOUR_USERNAME.github.io/pitchblob/`.

## License

MIT - see [LICENSE](LICENSE).
