# PitchOne

An open-source, phone-friendly **vocal pitch editor**, inspired by note-based editors like Melodyne. It is built from scratch with plain HTML + JavaScript, so it can be written and tested on a phone using only Termux.

> PitchOne is an independent hobby project. It is not affiliated with or endorsed by Celemony or Melodyne.

## Goal

Singers who only have a phone should be able to fix the pitch of a recorded vocal:

1. Load or record a vocal.
2. See each sung note as a "blob" on a piano roll.
3. Drag a blob up or down to correct its pitch.
4. Listen to the result and export it.

Scope: **single voice (monophonic) only**. Chords and polyphonic editing are out of scope. The app is designed for a phone held **sideways (landscape)**.

## Status

| Stage | What it does | Done |
|-------|--------------|------|
| 1 | Load an audio file, draw the waveform, play / stop | yes |
| 2 | Detect pitch over time (YIN algorithm), draw the pitch curve on a piano roll, live note readout | yes |
| 3 | Split the pitch curve into notes and draw them as blobs | |
| 4 | Drag blobs to change their pitch (data only, no sound yet) | |
| 5 | Re-synthesize the audio with the new pitches (PSOLA) | |
| 6 | Record from the microphone | |
| 7 | Export the result as a WAV file | |
| 8 | Package as an Android APK with GitHub Actions (Capacitor) | |

## Run it on your phone (Termux)

```bash
pkg install python
cd pitchone
python -m http.server 8000
```

Then open **http://localhost:8000** in your phone's browser (Chrome or Firefox) and turn the phone sideways.

Why a server? The code uses JavaScript modules, which browsers refuse to load when you open `index.html` directly as a file.

## How pitch detection works (Stage 2)

1. The recording is made mono and its sample rate is lowered to about 15 kHz (voices don't need more, and it makes the analysis ~9x faster).
2. Every 10 ms, the [YIN algorithm](http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf) compares a short slice of audio with a copy of itself shifted by different amounts. The shift where the two match best is the length of one wave cycle, and `frequency = sampleRate / cycle length`.
3. Silence, breath and consonants like "s" have no clear cycle, so they are marked "no pitch" and drawn as gaps.
4. Each frequency is converted to a note number (MIDI) and drawn on the piano roll.

Settings you can play with are at the top of `src/yin.js` (`threshold`, `silenceRms`) and `src/pitch.js` (`TARGET_RATE`, `HOP_SECONDS`).

## Tests

The tests make fake "voices" with maths (steady notes, glides, vibrato, silence, noise) and check the detector finds the right pitch. They need Node.js:

```bash
pkg install nodejs
node tests/yin.test.js
```

## Project layout

```
pitchone/
  index.html           the page
  style.css            how it looks (landscape-first)
  package.json         lets Node treat the .js files as modules (for the tests)
  src/
    main.js            wires the page together (open file, analyse, play, stop)
    waveform.js        computes and draws the waveform
    yin.js             the YIN pitch detector
    pitch.js           runs YIN over a whole recording -> pitch track
    pitchview.js       draws the piano roll and the pitch curve
    notes.js           frequency <-> note name helpers
  tests/
    yin.test.js        pitch detection tests
```

## Publish it on GitHub from Termux

```bash
cd pitchone
git add .
git commit -m "Describe what you changed"
git push
```

### Free hosting with GitHub Pages

On GitHub: **Settings > Pages > Deploy from a branch > main > / (root)**. After a minute the app is live at `https://YOUR_USERNAME.github.io/pitchone/`.

## License

MIT - see [LICENSE](LICENSE).
