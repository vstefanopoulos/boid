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
| `Params` | Reads all UI parameters into one per-block config object. |
| `Music` | Scale/key note graph, chord/tension analysis, constraints. |
| `Boid` | Per-voice state. |
| `Flock` | The boid update — separation/alignment/cohesion + note selection. |
| `MidiIn` | `HandleMIDI`: maintains the held chord / boid population. |
| `MidiOut` | Emits the short ornament Note On/Off pairs. |
| `Engine` | `ProcessMIDI`: drives the clock and schedules each voice. |
