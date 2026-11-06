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
| 4 | Edit the notes on screen: drag, Correct Pitch (Pitch Center / Pitch Drift / snap to scale), undo / redo, zoom | yes |
| 5 | Hear the edits: press a note, scrub across it, and Play plays the corrected recording (PSOLA pitch shifting) | yes |
| 5.1 | Cleaner pitch shifting on real voices, smooth scrubbing, loudness colours | yes |
| 6 | Record from the microphone | |
| 7 | Export the result as a WAV, FLAC or MP3 file | yes |
| 8 | Package as an Android APK with GitHub Actions (Capacitor) | |

## How to use it

Open the app, tap **Open** and choose a recording of a voice. After a few seconds the notes appear as blobs. The pitch line inside each blob is what the singer really did (vibrato and all).

| Do this | To get this |
|---------|-------------|
| Press a blob | Hear that note, at the pitch it is set to. It is also selected when you let go (its note name and cents show at the top right) |
| Drag sideways across a blob | Scrub: the sound follows your finger like a tape, at the same pitch. Slow finger = slow sound, stop = it fades out |
| Drag a blob up / down | Change its pitch. You hear it while you drag, and the whole note when you let go |
| Press and hold a blob | Add it to / remove it from the selection |
| Tap empty space | Deselect |
| Drag empty space | Scroll |
| Two fingers (pinch) | Zoom. Spread sideways = time, spread up/down = pitch |
| Double-tap empty space, or the fit button | Show everything |
| Tap or drag the strip at the bottom | Jump around the recording |
| **Correct Pitch** | Open the correction window (applies to the selected notes, or all notes if none are selected) |
| **Play** | Play the whole recording **with your edits** (the original if you have not changed anything), from the selected note or from the left edge of the screen |
| **Export** (download arrow) | Save the result as **WAV**, **FLAC** or **MP3**. Type the file name, pick the format and quality |
| Undo / redo buttons (Ctrl+Z / Ctrl+Shift+Z on a computer) | Go back / forward |
| Half-moon button | Switch between the light and dark theme |
| Corner button | Full screen (and landscape lock on phones that allow it) |

### Blob colours

The colour along a blob shows how loud the singing is: **dark red = quiet, red / orange = medium, bright yellow = loud**. The blob is also a little thicker where it is louder.

### Export

Tap the download arrow. Pick a name (it starts as `<your file>-edited`), a format and a quality:

| Format | Good for |
|--------|----------|
| WAV (16 / 24 / 32-bit float) | Exact copy, opens everywhere, big files |
| FLAC (16 / 24-bit) | Exact copy, about half the size of WAV |
| MP3 (128 - 320 kbps) | Small files to share |

The file has the same length, sample rate and channels as the recording you opened, with all your edits applied.

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
3. **Editing** (`correct.js`). Every note keeps the pitch that was sung and a target pitch. Inside a note, the wobble is split into slow drift and fast vibrato: `edited pitch = target + drift x (1 - drift amount) + vibrato`.
4. **Changing the sound** (`psola.js`). A voiced sound is a wave that repeats once per "period". PSOLA cuts the voice into one little grain per repeat, then puts the grains back closer together (higher pitch) or further apart (lower pitch) and overlaps them. Every grain keeps the voice's original shape, so the tone colour stays (no chipmunk voice) and the length does not change. Only edited notes are re-created. Everything else (breaths, consonants, untouched notes) is copied from the original, with a 25 ms crossfade at the edges.
   Real voices are messy (the repeats are never identical), so the grains must be cut at *exactly the same point of every repeat*. The first version picked "the highest peak", which jumps around on real voices and gives a buzzy, glitchy sound. Now every cut point is found by matching the shape of the previous repeat (a correlation search), and the grain spacing is averaged over a few neighbours so the tiny wobbles are not copied into the new sound.
5. **Previews** (`audition.js`). Pressing a note plays it (re-created if edited, and remembered so the second press is instant).
6. **Scrubbing** (`scrubsynth.js`, `scrub-worklet.js`). A "play position" chases your finger. The sound is played as 40 ms overlapping grains whose start is nudged by a few milliseconds so the waves line up (WSOLA), which keeps the pitch the same at any finger speed. If the finger stops, the sound holds for a moment and then fades. It runs in an audio worklet (the browser's audio thread), so it stays smooth while the screen is drawing.
7. **Colours** (`heat.js`). Loudness 0..1 -> dark red ... yellow, drawn as a gradient along each blob.
8. **Export** (`exporter.js`, `wav.js`, `flac.js`, `mp3.js`, `exportdialog.js`). WAV and FLAC are written by this project's own code (the FLAC encoder guesses each sample from the previous ones and stores only the small mistakes, with Rice coding). MP3 uses the LAME encoder in `vendor/`.
9. **Drawing and fingers** (`pitchview.js`, `view.js`, `gestures.js`). The roll draws the note rows, blobs and pitch lines. The view converts between pixels and (seconds, note number).

Settings you can play with: `SETTINGS` at the top of `src/segment.js` (for example `splitPenalty`: higher = fewer, longer notes) and `src/yin.js` (`threshold`, `silenceRms`).

## Tests

The tests make fake "voices" and fake pitch tracks with maths (steady notes, glides, vibrato, jitter, silence, noise) and check the detector, the note finder, the editing maths the pitch shifter (does the shifted voice really have the new pitch, the same length and loudness, and the same tone colour? Is it still clean on rough, breathy voices with vibrato?), the scrubbing engine, the colours and the export files (WAV / FLAC / MP3 are decoded again with `ffmpeg` if it is installed, and FLAC must come back bit-for-bit identical). They need Node.js:

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
  vendor/              other people's code (the MP3 encoder) - see vendor/README.md
  src/
    main.js            wires everything together
    yin.js             the YIN pitch detector
    pitch.js           runs YIN over a whole recording -> pitch track
    segment.js         pitch track -> notes
    correct.js         scales, moving notes, Correct Pitch, drift
    psola.js           pitch shifting: re-creates notes (or the whole recording) at their edited pitch
    audition.js        plays a note (press), scrubs (smooth), drag blips
    scrubsynth.js      the scrubbing sound engine (pure maths)
    scrub-worklet.js   runs scrubsynth.js in the browser's audio thread
    heat.js            loudness -> colour (dark red .. yellow)
    wav.js flac.js mp3.js   the file writers
    exporter.js        formats, file names, makes the file
    exportdialog.js    the Export window
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
    psola.test.js      pitch shifter tests
    quality.test.js    pitch shifter on messy, realistic voices
    voice.js           makes realistic fake voices (jitter, breath, vibrato, vowels)
    metrics.js         measures how clean / steady a sound is
    scrub.test.js      scrubbing engine tests
    heat.test.js       colour tests
    export.test.js     WAV / FLAC / MP3 file tests
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

The MP3 encoder in `vendor/` (lamejs, a port of LAME) is **LGPL-3.0**; it is kept as a separate, unmodified file. See `vendor/README.md`.
