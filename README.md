# PitchOne

An open-source, phone-friendly **vocal pitch editor**, inspired by note-based editors like Melodyne. It is built from scratch with plain HTML + JavaScript, so it can be written and tested on a phone using only Termux.

> PitchOne is an independent hobby project. It is not affiliated with or endorsed by Celemony or Melodyne.

## Goal

Singers who only have a phone should be able to fix the pitch of a recorded vocal:

1. Load or record a vocal.
2. See each sung note as a "blob" on a piano roll.
3. Drag a blob up or down, or let **Correct Pitch** pull the notes toward the right ones.
4. Listen to the result and export it.

Scope: **single voice (monophonic) only**. Chords and polyphonic editing are out of scope. The app is designed for a phone held **sideways (landscape)**.

## Status

| Stage | What it does | Done |
|-------|--------------|------|
| 1 | Load an audio file, draw the waveform, play / stop | yes |
| 2 | Detect pitch over time (YIN algorithm), piano roll, live note readout | yes |
| 3 | Clean the pitch curve and cut it into notes, drawn as blobs | yes |
| 4 | Edit the notes on screen: drag, Correct Pitch (Pitch Center / Pitch Drift / snap to scale), undo / redo, zoom | yes (picture only) |
| 5 | Re-synthesize the audio with the edited pitches (PSOLA) | |
| 6 | Record from the microphone | |
| 7 | Export the result as a WAV file | |
| 8 | Package as an Android APK with GitHub Actions (Capacitor) | |

**Important:** until Stage 5, editing changes the *picture* only. **Play** still plays the original recording.

## How to use it

Open the app, tap **Open** and choose a recording of a voice. After a few seconds the notes appear as blobs. The pitch line inside each blob is what the singer really did (vibrato and all).

| Do this | To get this |
|---------|-------------|
| Tap a blob | Select it (its note name and cents show at the top right) |
| Drag a blob up / down | Change its pitch |
| Press and hold a blob | Add it to / remove it from the selection |
| Tap empty space | Deselect |
| Drag empty space | Scroll |
| Two fingers (pinch) | Zoom. Spread sideways = time, spread up/down = pitch |
| Double-tap empty space, or the fit button | Show everything |
| Tap or drag the strip at the bottom | Jump around the recording |
| **Correct Pitch** | Open the correction window (applies to the selected notes, or all notes if none are selected) |
| **Play** | Play from the selected note, or from the left edge of the screen |
| Undo / redo buttons (Ctrl+Z / Ctrl+Shift+Z on a computer) | Go back / forward |
| Half-moon button | Switch between the light and dark theme |
| Corner button | Full screen (and landscape lock on phones that allow it) |

### Correct Pitch

- **Pitch Center**: how far each note moves toward its target note. 100 % = exactly on the note, 50 % = half way.
- **Pitch Drift**: how much of the slow creeping of the pitch inside a note is removed. 100 % keeps the vibrato but straightens the creep.
- **Snap to scale**: pull notes to the nearest note of a key and scale (for example C major). Untick it to snap to the nearest semitone.
- **Include notes fine-tuned manually**: by default, notes you dragged by hand are left alone.

A dashed grey line shows where a changed note was originally sung.

## Run it on your phone (Termux)

```bash
pkg install python
cd pitchone
python -m http.server 8000
```

Then open **http://localhost:8000** in your phone's browser (Chrome or Firefox) and turn the phone sideways.

Why a server? The code uses JavaScript modules, which browsers refuse to load when you open `index.html` directly as a file.

## How it works

1. **Pitch detection** (`yin.js`, `pitch.js`). The recording is made mono and its sample rate is lowered to about 15 kHz. Every 10 ms the [YIN algorithm](http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf) compares a short slice of audio with a copy of itself shifted by different amounts. The shift where the two match best is the length of one wave cycle, and `frequency = sampleRate / cycle length`. Silence, breath and consonants like "s" get "no pitch".
2. **Notes** (`segment.js`). Glitches are removed with a median filter. The curve is then described as a staircase of flat notes, where each extra step has to "pay" a penalty: a real change of note improves the fit a lot, vibrato only a little, so vibrato never splits a note. Dips in volume split repeated notes ("la la la"). Notes that are too short are merged into their neighbours.
3. **Editing** (`correct.js`). Every note keeps the pitch that was sung and a target pitch. Inside a note, the wobble is split into slow drift and fast vibrato: `edited pitch = target + drift x (1 - drift amount) + vibrato`. Stage 5 will use this to re-synthesize the sound.
4. **Drawing and fingers** (`pitchview.js`, `view.js`, `gestures.js`). The roll draws the note rows, blobs and pitch lines. The view converts between pixels and (seconds, note number).

Settings you can play with: `SETTINGS` at the top of `src/segment.js` (for example `splitPenalty`: higher = fewer, longer notes) and `src/yin.js` (`threshold`, `silenceRms`).

## Tests

The tests make fake "voices" and fake pitch tracks with maths (steady notes, glides, vibrato, jitter, silence, noise) and check the detector, the note finder and the editing maths. They need Node.js:

```bash
pkg install nodejs
npm test
```

## Project layout

```
pitchone/
  index.html           the page (toolbar, roll, overview strip, Correct Pitch window)
  style.css            how it looks (landscape-first)
  package.json         lets Node treat the .js files as modules (for the tests)
  src/
    main.js            wires everything together
    yin.js             the YIN pitch detector
    pitch.js           runs YIN over a whole recording -> pitch track
    segment.js         pitch track -> notes
    correct.js         scales, moving notes, Correct Pitch, drift
    history.js         undo / redo
    view.js            zoom / scroll maths
    pitchview.js       draws the roll and the blobs
    gestures.js        finger and mouse control
    correctdialog.js   the Correct Pitch window
    waveform.js        the overview strip
    theme.js           light and dark colours
    notes.js           frequency <-> note name helpers
  tests/
    check.js           tiny test helper
    yin.test.js        pitch detection tests
    segment.test.js    note finding tests
    edit.test.js       editing, undo and zoom tests
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
