# BoidOrnamenter

A boids-inspired MIDI ornamentation engine for **Logic Pro's Scripter** plugin.

Hold a chord and BoidOrnamenter treats each held note as an independent
**boid** (a voice) that wanders around the harmony, generating continuously
evolving, contrapuntal ornamentation. The goal is output that sounds like
several intelligent players improvising around a held chord — not a random
note generator and not a conventional arpeggiator.

---

## How it works

Each held note spawns a voice with its own state (pitch, direction, energy,
age, timing). On every audio block the flock is updated using the three
classic boid rules, reinterpreted **musically**:

| Rule | Musical meaning |
|------|-----------------|
| **Separation** | Voices avoid landing on the same pitch or creating harsh clashes (unisons, minor 2nds). |
| **Alignment** | Neighbouring voices tend to move in the same melodic direction. |
| **Cohesion** | Voices are gently pulled back toward the harmonic centre of the held chord. |

Motion is never free — every voice moves through a **musical note graph**:

- **Stays in the selected scale/key.**
- **Prefers chord tones**, occasionally visiting tensions (9ths, 11ths, 13ths).
- **Moves by step or third** by default (opens up as *Max Interval* grows).
- **Stays within a register limit** (± octaves from its original note).
- **Avoids voice crossing** unless you enable it.

Notes are chosen with a **weighted (softmax) random pick** from the allowed
candidates, so the motion is coherent but never repetitive.

The chord is analysed dynamically: **chord tones are the pitch classes you're
actually holding**, and **tensions are the remaining scale degrees** — so the
harmony follows whatever you play, in whatever key/scale you set.

> By default the incoming chord is used only to drive the boids and is **not**
> passed to the instrument — you hear the ornament voices alone. Enable
> **Pass Through Chord** to also sustain the original harmony underneath.

---

## Installation

1. In Logic Pro, add a **Software Instrument** track.
2. In the channel strip's **MIDI FX** slot, insert **Scripter**.
3. Click **Open Script in Editor**.
4. Delete the default script, paste the contents of **`BoidOrnamenter.js`**.
5. Click **Run Script**.
6. Hold a chord and tweak the parameters live.

Everything lives in the single file `BoidOrnamenter.js` (Scripter loads one
script). It contains no external dependencies.

---

## Parameters

### Boid Forces
| Parameter | Range | Default | Effect |
|-----------|-------|---------|--------|
| **Movement Intensity** | 0–1 | 0.5 | Low = voices like to sit still; high = they travel more and take bigger steps. |
| **Separation Strength** | 0–1 | 0.6 | How strongly voices repel each other to avoid clashes/unisons. |
| **Cohesion Strength** | 0–1 | 0.5 | How strongly voices are pulled toward the chord's centre of gravity. |
| **Alignment Strength** | 0–1 | 0.5 | How much voices imitate their neighbours' direction of motion. |

### Note Graph
| Parameter | Range | Default | Effect |
|-----------|-------|---------|--------|
| **Scale** | menu | Major | Scale the voices are confined to (Major, minor modes, pentatonics, blues, whole-tone, chromatic, …). |
| **Key** | menu | C | Root of the scale. |
| **Chord-Tone Preference** | 0–1 | 0.7 | Weight given to landing on chord tones. |
| **Tension Probability** | 0–1 | 0.25 | Weight given to non-chord scale tones (9/11/13 colour). |
| **Max Interval (semitones)** | 1–12 | 4 | Largest allowed melodic leap. ≥7 unlocks fourth-ish (3 scale-step) motion. |
| **Register Range (± oct)** | 0–3 | 1 | How far, in octaves, each voice may stray from its original note. |
| **Voice Crossing** | Off/On | Off | Off keeps voices in their original low→high order. |
| **Pass Through Chord** | Off/On | **Off** | On also forwards the held chord so ornaments layer over the sustained harmony. |

### Rhythm & Output
| Parameter | Range | Default | Effect |
|-----------|-------|---------|--------|
| **Update Rate** | menu | 1/16 | Grid on which each voice re-evaluates and may fire (1/4 … 1/32, incl. triplets). |
| **Ornament Density** | 0–1 | 0.6 | Probability a voice actually sounds a note on each update — lower = sparser. |
| **Note Length** | 0.1–1.5× | 0.7 | Ornament note duration as a multiple of the update rate. |
| **Velocity Scale** | 0.2–1.2 | 0.85 | Scales ornament velocity relative to your played velocity. |
| **Humanize** | 0–1 | 0.25 | Randomises timing and velocity slightly for a less mechanical feel. |

### Telemetry
| Parameter | Range | Default | Effect |
|-----------|-------|---------|--------|
| **Telemetry** | Off/On | **Off** | Broadcasts the full flock state as MIDI CC for the live visualiser. See below. |
| **Seed (0 = random)** | 0–999 | 0 | Non-zero makes the performance reproducible: same chord + same parameters + same seed = the same notes. 0 = a fresh random stream on every reset. |

---

## Live visualizer

`boid-visualizer.html` is a single self-contained page that draws the flock in
real time — every voice's position in the note graph, its home note, its
register box, its energy and its direction of travel.

The look borrows from [Ben Eater's boids demo](https://eater.net/boids): a dark
stage, each boid a **dart banked along its heading**, with a fading trail behind
it. The difference is the space they fly through. Eater's boids move in free 2D;
BoidOrnamenter's have exactly one spatial dimension — **pitch** — so the flock
flies rightward through **time** (x) while banking up and down through **pitch**
(y). Nothing on the canvas is invented: a dart's angle is the actual slope of
the interval it just moved.

It does **not** reverse-engineer the flock from the ornament notes, because that
cannot work: at the default *Ornament Density* of 0.6, roughly **40% of the
boids' steps never produce a note at all**, and every voice shares one MIDI
channel. Instead the script simply *states* what each boid is doing, once per
step, over a small MIDI CC protocol.

The pitch axis is **fixed to the full 88-key piano (A0–C8) and never rescales**,
so the same note is always at the same height and two takes can be compared by
eye. Black-key rows are striped faintly behind the flock as a reference. A chord
therefore occupies only part of the stage — that is the point: you can see *where*
in the instrument the flock is living, not just how it is moving.

Reading the canvas:

| Mark | Meaning |
|------|---------|
| **Solid dart** | A step that sounded — size scales with the ornament's velocity. |
| **Hollow dart** | A step the *Density* gate silenced. The voice still moved. No recorded MIDI file contains these. |
| **Glowing lead dart** | The voice's current position; the glow is its `energy`. |
| **Dimmed level dart + flat line** | The chord was released. See below. |
| **Dashed line** | The voice's home note (the held chord tone it orbits). |
| **Tinted band** | Its *Register Range* box — the pitches it is allowed to reach. |

When you let the chord go, the flock stops existing — but blanking the canvas
reads as a glitch, so the visualiser **sustains the last frame** instead: the
voices coast level at their final pitch, dimmed, tagged `HELD` in the legend, and
the pitch axis stays where it was. Play a new chord and it takes over cleanly,
discarding the sustained picture.

### Why a voice is not dropped the moment the count falls

The visualiser deliberately does **not** trust CC 110 (voice count) to decide
whether a voice is alive. `removeBoid()` fires `flockSize()` on every note-off,
so a MIDI file that re-articulates a chord reports 2 voices — or 0 — in the gap
between the note-off and the note-on that replaces it. Retiring a voice on that
dip destroys its trail and rebuilds it as a stub, which is why a steady 3-voice
file could render as 2.

Instead, liveness is **per-voice and time-based**: a voice is considered stopped
only when its *own* telemetry has been quiet for longer than a few of its steps.
That window scales with the actual step interval — `Update Rate × tempo`, floored
at 1.5 s — because a voice only emits telemetry when it steps, and one step at
1/4 and a slow tempo is over a second. A momentary dip in the count is ignored;
a voice that is still stepping is still alive, whatever the count says.

The page commits to a single dark theme rather than following your system
light/dark setting — that is the aesthetic, not an oversight.

### Setting it up

1. **Enable the IAC Driver.** Open *Audio MIDI Setup* → *Window* → *Show MIDI
   Studio* → double-click **IAC Driver** → tick **Device is online**. Make sure
   it has at least one bus (e.g. *IAC Bus 1*).
2. **Give Logic a way out.** A Software Instrument track's MIDI doesn't leave
   Logic on its own, so use the **External Instrument** plugin as the track's
   instrument and point its *MIDI Destination* at **IAC Bus 1**. The chain is:

   ```
   MIDI FX: Scripter (BoidOrnamenter)  →  Instrument: External Instrument  →  IAC Bus 1
   ```

   You can ignore the audio return — the point is only to get MIDI onto the bus.
3. **Set Telemetry to On** in the Scripter UI.
4. **Open `boid-visualizer.html` in Chrome**, click **Enable MIDI**, grant the
   permission prompt, and select *IAC Bus 1* from the dropdown.
5. Hold a chord.

The **Demo** button feeds the page synthetic frames in the same wire format, so
you can confirm it renders before wiring any of this up. The **Table** button
shows the same voice state as text.

> **Web MIDI is Chrome-only** in practice, and needs a secure context. Opening
> the file directly (`file://…`) works; if your setup refuses, serve it with
> `python3 -m http.server` and open `http://localhost:8000/boid-visualizer.html`.

> **Telemetry CCs travel downstream to the instrument too.** They sit on CC
> 102–114, which are undefined in the MIDI spec and ignored by most synths — but
> if your instrument has something mapped there, either remap it or keep the
> visualiser feed on a track that isn't making sound. Telemetry is Off by
> default for exactly this reason.

### Protocol v1

Both `BoidOrnamenter.js` and `boid-visualizer.html` hard-code this; change one
and you must change the other.

**Per-voice stream** — channel = the voice's low→high rank + 1 (so channel 1 is
the lowest voice, up to 15 voices):

| CC | Meaning |
|----|---------|
| 102 | Current pitch, 0–127 — the boid's actual position in the note graph |
| 103 | Source pitch — the held note this voice orbits |
| 104 | Energy × 127 |
| 105 | Direction: 0 = down, 64 = held, 127 = up |
| 106 | 0 = this step was silenced by *Density*; otherwise the ornament velocity |

CC 106 is sent **last** and acts as the commit marker that closes the voice's frame.

**Global stream** — channel 16:

| CC | Meaning |
|----|---------|
| 110 | Voice count |
| 111 | Parameter index, then… |
| 112 | …parameter value, normalised 0–127 over that parameter's own range |
| 113 | Flock event (0 = reset) |
| 114 | Tempo ÷ 2 (so 0–254 BPM) |

The whole parameter block is re-broadcast every 4 beats, and any live knob move
is pushed immediately. This is what keeps the visualiser correct when you change
parameters or the chord **mid-flight** — none of which is recoverable from a
recorded MIDI file, since parameter automation never enters the MIDI stream.

---

## Reproducible runs

Every stochastic decision draws from a seedable PRNG rather than `Math.random()`.
Set **Seed** to any non-zero value and the same chord, the same parameters and
the same seed reproduce the same performance note for note — useful for A/B-ing
parameter changes against a fixed reference, or for re-rendering a take you
liked. Seed 0 keeps the old behaviour: a fresh random stream on every reset.

Reproducibility holds for a given tempo and buffer size. The engine catches up at
most 4 steps per audio block, so an extreme change of buffer size can in
principle shift where that cap bites; in practice a seeded run repeats exactly.

---

## Tips

- **Sparse, tasteful runs:** lower *Ornament Density* (~0.3) and *Movement
  Intensity*, raise *Cohesion*.
- **Busy, swirling texture:** raise *Density* and *Intensity*, faster
  *Update Rate* (1/16 or 1/32).
- **Wider, more independent lines:** raise *Max Interval* and
  *Register Range*, enable *Voice Crossing*.
- **More "outside" colour:** raise *Tension Probability*, lower
  *Chord-Tone Preference*.
- The engine has a **free-running clock**, so ornaments keep evolving even on
  a held chord while the transport is stopped.

---

## Code structure

The file is organised into self-contained "modules" so new musical
behaviours can be added later:

| Module | Responsibility |
|--------|----------------|
| `Clock` | Tempo-locked, free-running beat clock (works while stopped). |
| `Rng` | Seedable PRNG (mulberry32) — every random draw in the engine comes from here. |
| `Params` | Reads all UI parameters into one per-block config object. |
| `Music` | Scale/key note graph, chord/tension analysis, constraints. |
| `Boid` | Per-voice state. |
| `Flock` | The boid update — separation/alignment/cohesion + note selection. |
| `MidiIn` | `HandleMIDI`: maintains the held chord / boid population. |
| `MidiOut` | Emits the short ornament Note On/Off pairs. |
| `Telemetry` | Broadcasts the full flock state as MIDI CC for the visualiser. |
| `Engine` | `ProcessMIDI`: drives the clock and schedules each voice. |

Two files, no dependencies: `BoidOrnamenter.js` (the Scripter plugin) and
`boid-visualizer.html` (the optional live visualiser).

### A note on mid-flight parameter changes

*Register Range* and *Voice Crossing* define a box relative to a voice's **source
pitch**, not to where the voice currently is. Tightening either one while a voice
sits outside the new box used to leave it with no legal candidate — permanently
frozen, and (because the density gate is independent of whether the step moved)
machine-gunning the same stuck note forever. `Flock.step` now detects that state
and walks the voice back toward legality, ignoring *Max Interval* for that one
recovery leap, since a narrow *Max Interval* is exactly what would otherwise trap
it.
