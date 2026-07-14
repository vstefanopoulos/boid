/*==============================================================================
  BoidOrnamenter — a boids-inspired ornamentation engine for Logic Pro Scripter
================================================================================

  Treat every held MIDI note as an independent "boid" (a voice). While a chord
  is held, each voice wanders around the harmony using the three classic boid
  rules reinterpreted musically:

      Separation  – voices avoid landing on / clashing with each other.
      Alignment   – neighbouring voices tend to move in the same direction.
      Cohesion    – voices are pulled back toward the harmonic centre.

  Motion is constrained to a musical note graph (scale membership, chord-tone
  preference, stepwise/third motion, per-voice register limits and optional
  no-voice-crossing) so the result behaves like several players improvising
  around a held chord rather than a random note generator or an arpeggiator.

  Everything lives in one file (Scripter loads a single script), but the code is
  split into self-contained "modules" so new musical behaviours can be bolted on
  later:

      Clock     – tempo-locked, free-running beat clock (works while stopped too)
      Rng       – seedable PRNG, so a run can be reproduced exactly
      Params    – reads all UI parameters into one config object
      Music     – scale/key graph + chord/tension analysis + constraints
      Boid      – per-voice state
      Flock     – the boid update (separation / alignment / cohesion + selection)
      MidiIn    – HandleMIDI: maintains the held chord / boid population
      MidiOut   – emits the short ornament Note On/Off pairs
      Telemetry – broadcasts full flock state as MIDI CC, for a live visualiser
      Engine    – ProcessMIDI: drives the clock and schedules each voice

==============================================================================*/

var NeedsTimingInfo = true;   // required so GetTimingInfo() returns tempo/beats
var DEBUG = false;            // set true to Trace() diagnostics

/*==============================================================================
  MODULE: Rng — seedable PRNG (mulberry32)

  Every stochastic decision in the engine draws from here rather than from
  Math.random(), so that with a non-zero Seed the same chord + the same
  parameters reproduce the same performance, note for note. Seed 0 keeps the
  old behaviour: a fresh random stream on every reset.
==============================================================================*/
var Rng = (function () {
    var state = 1;

    function seed(s) {
        state = (s >>> 0) || 1;
    }
    function randomize() {
        state = (Math.random() * 4294967296) >>> 0 || 1;
    }
    function next() {
        state = (state + 0x6D2B79F5) >>> 0;
        var t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    randomize();
    return { seed: seed, randomize: randomize, next: next };
})();

/*==============================================================================
  MODULE: Music — scale graph, chord analysis and musical constraints
==============================================================================*/
var Music = (function () {

    // Semitone offsets from the key root. Order must match the Scale menu below.
    var SCALES = [
        { name: "Major (Ionian)",  steps: [0, 2, 4, 5, 7, 9, 11] },
        { name: "Natural Minor",   steps: [0, 2, 3, 5, 7, 8, 10] },
        { name: "Harmonic Minor",  steps: [0, 2, 3, 5, 7, 8, 11] },
        { name: "Melodic Minor",   steps: [0, 2, 3, 5, 7, 9, 11] },
        { name: "Dorian",          steps: [0, 2, 3, 5, 7, 9, 10] },
        { name: "Phrygian",        steps: [0, 1, 3, 5, 7, 8, 10] },
        { name: "Lydian",          steps: [0, 2, 4, 6, 7, 9, 11] },
        { name: "Mixolydian",      steps: [0, 2, 4, 5, 7, 9, 10] },
        { name: "Pentatonic Maj",  steps: [0, 2, 4, 7, 9] },
        { name: "Pentatonic Min",  steps: [0, 3, 5, 7, 10] },
        { name: "Blues",           steps: [0, 3, 5, 6, 7, 10] },
        { name: "Whole Tone",      steps: [0, 2, 4, 6, 8, 10] },
        { name: "Chromatic",       steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
    ];

    var KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    // Cached, sorted list of every in-scale MIDI pitch for the current key/scale.
    var scalePitches = [];       // e.g. [0,2,4,5,7,9,11,12,...]
    var pitchIndex   = null;     // pitch -> index in scalePitches (or nearest)
    var cachedKey = -1, cachedScale = -1;

    function rebuild(keyRoot, scaleIndex) {
        if (keyRoot === cachedKey && scaleIndex === cachedScale) return;
        cachedKey = keyRoot;
        cachedScale = scaleIndex;

        var steps = SCALES[scaleIndex].steps;
        var inScale = {};
        for (var s = 0; s < steps.length; s++) {
            inScale[(steps[s] + keyRoot) % 12] = true;
        }
        scalePitches = [];
        pitchIndex = new Array(128);
        for (var p = 0; p <= 127; p++) {
            if (inScale[p % 12]) scalePitches.push(p);
        }
        // Map every MIDI pitch to the index of the nearest in-scale pitch,
        // so an out-of-scale held note still slots cleanly into the graph.
        var idx = 0;
        for (var q = 0; q <= 127; q++) {
            while (idx < scalePitches.length - 1 &&
                   Math.abs(scalePitches[idx + 1] - q) <= Math.abs(scalePitches[idx] - q)) {
                idx++;
            }
            pitchIndex[q] = idx;
        }
    }

    function snap(pitch) {
        pitch = Math.max(0, Math.min(127, Math.round(pitch)));
        return scalePitches[pitchIndex[pitch]];
    }

    // Candidate pitches reachable from `pitch`: 0..maxScaleSteps scale-degrees
    // away (a "third" is 2 scale steps), capped by maxInterval in semitones.
    // Returns objects {pitch, steps} where steps is signed scale-degree distance.
    function candidates(pitch, maxInterval, maxScaleSteps) {
        var here = pitchIndex[Math.max(0, Math.min(127, pitch))];
        var out = [];
        for (var d = -maxScaleSteps; d <= maxScaleSteps; d++) {
            var i = here + d;
            if (i < 0 || i >= scalePitches.length) continue;
            var np = scalePitches[i];
            if (Math.abs(np - pitch) > maxInterval) continue;
            out.push({ pitch: np, steps: d });
        }
        return out;
    }

    // Chord tones = pitch classes actually held; tensions = other scale degrees.
    function isChordTone(pitch, chordPcs) {
        return chordPcs[pitch % 12] === true;
    }

    return {
        SCALES: SCALES,
        KEYS: KEYS,
        rebuild: rebuild,
        snap: snap,
        candidates: candidates,
        isChordTone: isChordTone
    };
})();

/*==============================================================================
  MODULE: Params — parameter definitions + a per-block config snapshot
==============================================================================*/

// Update-rate menu -> length in beats (quarter note = 1 beat).
var RATE_BEATS = {
    "1/4": 1.0, "1/4T": 2 / 3, "1/8": 0.5, "1/8T": 1 / 3,
    "1/16": 0.25, "1/16T": 1 / 6, "1/32": 0.125
};
var RATE_NAMES = ["1/4", "1/4T", "1/8", "1/8T", "1/16", "1/16T", "1/32"];

var PluginParameters = [
    { name: "— Boid Forces —", type: "text" },
    { name: "Movement Intensity", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.5, numberOfSteps: 100 },
    { name: "Separation Strength", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.6, numberOfSteps: 100 },
    { name: "Cohesion Strength", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.5, numberOfSteps: 100 },
    { name: "Alignment Strength", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.5, numberOfSteps: 100 },

    { name: "— Note Graph —", type: "text" },
    { name: "Scale", type: "menu", valueStrings: Music.SCALES.map(function (s) { return s.name; }), defaultValue: 0 },
    { name: "Key", type: "menu", valueStrings: Music.KEYS, defaultValue: 0 },
    { name: "Chord-Tone Preference", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.7, numberOfSteps: 100 },
    { name: "Tension Probability", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.25, numberOfSteps: 100 },
    { name: "Max Interval (semitones)", type: "lin", minValue: 1, maxValue: 12, defaultValue: 4, numberOfSteps: 11 },
    { name: "Register Range (± oct)", type: "lin", minValue: 0, maxValue: 3, defaultValue: 1, numberOfSteps: 3 },
    { name: "Voice Crossing", type: "menu", valueStrings: ["Off", "On"], defaultValue: 0 },
    { name: "Pass Through Chord", type: "menu", valueStrings: ["Off", "On"], defaultValue: 0 },

    { name: "— Rhythm & Output —", type: "text" },
    { name: "Update Rate", type: "menu", valueStrings: RATE_NAMES, defaultValue: 4 /* 1/16 */ },
    { name: "Ornament Density", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.6, numberOfSteps: 100 },
    { name: "Note Length", type: "lin", minValue: 0.1, maxValue: 1.5, defaultValue: 0.7, numberOfSteps: 140, unit: "x rate" },
    { name: "Velocity Scale", type: "lin", minValue: 0.2, maxValue: 1.2, defaultValue: 0.85, numberOfSteps: 100 },
    { name: "Humanize", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.25, numberOfSteps: 100 },

    { name: "— Telemetry —", type: "text" },
    // Off by default: when On this streams a few hundred CC/sec downstream, which
    // an instrument on the same track would also receive. See README.
    { name: "Telemetry", type: "menu", valueStrings: ["Off", "On"], defaultValue: 0 },
    { name: "Seed (0 = random)", type: "lin", minValue: 0, maxValue: 999, defaultValue: 0, numberOfSteps: 999 }
];

var Params = (function () {
    // Read the current UI state into one plain object once per process block.
    function snapshot() {
        var rateName = RATE_NAMES[GetParameter("Update Rate")];
        return {
            intensity:   GetParameter("Movement Intensity"),
            separation:  GetParameter("Separation Strength"),
            cohesion:    GetParameter("Cohesion Strength"),
            alignment:   GetParameter("Alignment Strength"),

            scale:       GetParameter("Scale"),
            key:         GetParameter("Key"),
            chordPref:   GetParameter("Chord-Tone Preference"),
            tensionProb: GetParameter("Tension Probability"),
            maxInterval: Math.round(GetParameter("Max Interval (semitones)")),
            octaves:     Math.round(GetParameter("Register Range (± oct)")),
            crossing:    GetParameter("Voice Crossing") === 1,

            rateBeats:   RATE_BEATS[rateName],
            density:     GetParameter("Ornament Density"),
            noteLength:  GetParameter("Note Length"),
            velScale:    GetParameter("Velocity Scale"),
            humanize:    GetParameter("Humanize"),

            telemetry:   GetParameter("Telemetry") === 1
        };
    }
    return { snapshot: snapshot };
})();

/*==============================================================================
  MODULE: Clock — a free-running beat clock derived from GetTimingInfo().
  Advances every ProcessMIDI block whether or not the transport is playing,
  so ornaments keep evolving even on a stopped, held chord.
==============================================================================*/
var Clock = (function () {
    var beat = 0;       // internal, monotonically increasing beat position
    var tempo = 120;

    function advance(info) {
        tempo = (info && info.tempo > 0) ? info.tempo : tempo;
        var len = (info && info.blockLength > 0) ? info.blockLength : 0;
        beat += len;
        return beat;
    }
    function now()        { return beat; }
    function getTempo()   { return tempo; }
    function beatsToMs(b) { return b * 60000 / tempo; }
    function reset()      { beat = 0; }

    return { advance: advance, now: now, getTempo: getTempo, beatsToMs: beatsToMs, reset: reset };
})();

/*==============================================================================
  MODULE: Boid — per-voice state
==============================================================================*/
class Boid {
    constructor(srcPitch, srcVelocity, channel) {
        this.srcPitch    = srcPitch;                 // the held note this voice orbits
        this.srcVelocity = srcVelocity;
        this.channel     = channel;
        this.curPitch    = Music.snap(srcPitch);     // current position in the graph
        this.dir         = Rng.next() < 0.5 ? 1 : -1;
        this.energy      = 0.5 + Rng.next() * 0.5;
        this.age         = 0;
        this.phase       = Rng.next();               // desyncs voices from each other
        this.nextFireBeat = 0;                        // when this voice next updates
        this.activePitch  = -1;                       // ornament currently sounding, -1 = none
        this.rank         = 0;                         // low->high ordering for crossing rules
    }
}

/*==============================================================================
  MODULE: Flock — the boid update: separation / alignment / cohesion + a
  weighted (softmax) note choice from the constrained candidate set.
==============================================================================*/
var Flock = (function () {

    var SELECTIVITY = 1.6;   // higher = more decisive note choices, lower = looser

    // Shared harmonic context recomputed once per block.
    function context(boids) {
        var chordPcs = {};
        var sum = 0, dirSum = 0;
        for (var i = 0; i < boids.length; i++) {
            chordPcs[boids[i].srcPitch % 12] = true;
            sum += boids[i].curPitch;
            dirSum += boids[i].dir;
        }
        return {
            chordPcs: chordPcs,
            centroid: boids.length ? sum / boids.length : 60,
            avgDir:   boids.length ? dirSum / boids.length : 0
        };
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function sign(v)          { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

    // Score one candidate pitch `c` for boid `b` against the whole flock.
    function score(c, b, boids, ctx, cfg) {
        var d = c - b.curPitch;

        // COHESION: pull toward the harmonic centre of the held chord.
        var cohesion = cfg.cohesion * (1 - clamp(Math.abs(c - ctx.centroid) / 12, 0, 1));

        // ALIGNMENT: reward moving the same way as the neighbouring voices.
        var alignment = 0;
        if (d !== 0) alignment = cfg.alignment * sign(d) * ctx.avgDir;

        // SEPARATION: penalise clustering / clashes with the other voices.
        var sep = 0;
        for (var i = 0; i < boids.length; i++) {
            if (boids[i] === b) continue;
            var iv = Math.abs(c - boids[i].curPitch);
            sep += (iv === 0) ? 1.0 : (iv === 1) ? 0.6 : (iv === 2) ? 0.2 : 0;
        }
        var separation = -cfg.separation * sep;

        // MOVEMENT INTENSITY: low = like to sit still, high = like to travel.
        var motion;
        if (d === 0) motion = (1 - cfg.intensity) * 0.6;
        else         motion = cfg.intensity * 0.3 * (Math.abs(d) / cfg.maxInterval);

        return cohesion + alignment + separation + motion;
    }

    // Voice-crossing guard: candidate must stay between the rank-neighbours.
    // Returns 0 when it does, else how far outside the bracket it sits.
    function crossingCost(c, b, boids) {
        var lo = -Infinity, hi = Infinity;
        for (var i = 0; i < boids.length; i++) {
            if (boids[i] === b) continue;
            if (boids[i].rank === b.rank - 1) lo = boids[i].curPitch;
            if (boids[i].rank === b.rank + 1) hi = boids[i].curPitch;
        }
        if (lo !== -Infinity && c <= lo) return (lo - c) + 1;
        if (hi !== Infinity  && c >= hi) return (c - hi) + 1;
        return 0;
    }
    function crossingOk(c, b, boids) { return crossingCost(c, b, boids) === 0; }

    // How badly a pitch breaks this voice's register / crossing constraints.
    // 0 = fully legal. Used only to escape a boxed-in state (see step()).
    function violation(c, b, boids, cfg) {
        var v = 0;
        var lowLimit  = b.srcPitch - cfg.octaves * 12;
        var highLimit = b.srcPitch + cfg.octaves * 12;
        if (c < lowLimit)  v += lowLimit - c;
        if (c > highLimit) v += c - highLimit;
        if (!cfg.crossing) v += crossingCost(c, b, boids);
        return v;
    }

    // Advance a single boid one step through the note graph.
    function step(b, boids, ctx, cfg) {
        b.age++;
        b.energy = clamp(b.energy + (Rng.next() - 0.5) * 0.15, 0.15, 1);

        // Up to a third (2 scale steps) by default; open up as Max Interval grows.
        var maxSteps = cfg.maxInterval >= 7 ? 3 : 2;
        var cands = Music.candidates(b.curPitch, cfg.maxInterval, maxSteps);

        var lowLimit  = b.srcPitch - cfg.octaves * 12;
        var highLimit = b.srcPitch + cfg.octaves * 12;

        var weights = [], pool = [], total = 0;
        for (var i = 0; i < cands.length; i++) {
            var c = cands[i].pitch;
            if (c < lowLimit || c > highLimit) continue;             // register range
            if (!cfg.crossing && !crossingOk(c, b, boids)) continue; // voice crossing

            // Chord-tone preference vs. occasional tension colour.
            var tone = Music.isChordTone(c, ctx.chordPcs)
                     ? Math.max(cfg.chordPref, 0.02)
                     : Math.max(cfg.tensionProb, 0.005);

            var w = Math.exp(score(c, b, boids, ctx, cfg) * SELECTIVITY) * tone;
            pool.push(c);
            weights.push(w);
            total += w;
        }

        // Boxed in: no legal candidate. This happens when Register Range or Voice
        // Crossing is tightened while the voice is sitting outside the new window —
        // the box is defined relative to srcPitch, not to where the voice actually
        // is, so it can end up stranded outside a box it can no longer step into.
        // Walk back toward legality instead of freezing (and machine-gunning) here
        // forever. The escape ignores Max Interval on purpose: it is a one-off
        // recovery leap, not normal motion, and a narrow Max Interval is exactly
        // what would otherwise leave the voice with nowhere to go.
        if (!pool.length) {
            var esc = Music.candidates(b.curPitch, 24, 3);
            var best = b.curPitch, bestV = violation(b.curPitch, b, boids, cfg);
            for (var k = 0; k < esc.length; k++) {
                var v = violation(esc[k].pitch, b, boids, cfg);
                if (v < bestV) { bestV = v; best = esc[k].pitch; }
            }
            if (best !== b.curPitch) {
                b.dir = sign(best - b.curPitch);
                b.curPitch = best;
            }
            return;
        }

        // Weighted random pick keeps motion organic and non-repetitive.
        var r = Rng.next() * total, chosen = pool[0];
        for (var j = 0; j < pool.length; j++) {
            r -= weights[j];
            if (r <= 0) { chosen = pool[j]; break; }
        }

        if (chosen !== b.curPitch) b.dir = sign(chosen - b.curPitch);
        b.curPitch = chosen;
    }

    return { context: context, step: step };
})();

/*==============================================================================
  MODULE: MidiOut — emit ornament Note On + scheduled Note Off
==============================================================================*/
var MidiOut = (function () {
    function clampVel(v) { return Math.max(1, Math.min(127, Math.round(v))); }

    // Fire the boid's current pitch as a short ornament note.
    // Returns the velocity used, so Telemetry can report what actually sounded.
    function ornament(b, cfg) {
        var hum = cfg.humanize;
        var velOsc = 0.75 + 0.25 * Math.sin(b.age * 0.5);           // gentle breathing
        var velRand = 1 - hum * 0.4 * Rng.next();
        var vel = clampVel(b.srcVelocity * cfg.velScale * velOsc * velRand * b.energy);

        var on = new NoteOn();
        on.pitch = b.curPitch;
        on.velocity = vel;
        on.channel = b.channel;
        on.send();

        var lenBeats = cfg.rateBeats * cfg.noteLength * (1 - hum * 0.3 * Rng.next());
        var off = new NoteOff();
        off.pitch = b.curPitch;
        off.velocity = 0;
        off.channel = b.channel;
        off.sendAfterMilliseconds(Math.max(10, Clock.beatsToMs(lenBeats)));

        b.activePitch = b.curPitch;
        return vel;
    }

    // Immediately silence a voice's still-sounding ornament (used on release/reset).
    function silence(b) {
        if (b.activePitch < 0) return;
        var off = new NoteOff();
        off.pitch = b.activePitch;
        off.velocity = 0;
        off.channel = b.channel;
        off.send();
        b.activePitch = -1;
    }

    return { ornament: ornament, silence: silence };
})();

/*==============================================================================
  MODULE: Telemetry — broadcast the full flock state as MIDI CC

  Scripter is sandboxed: no sockets, no filesystem, no OSC. MIDI is the only
  wire out. So instead of a visualiser trying to reverse-engineer the flock
  from the ornament notes — which cannot work, because the ~(1 - Density) of
  steps that are silenced never produce a note, and all voices share a channel
  — the engine simply *states* what every boid is doing, once per step.

  PROTOCOL v1  (must stay in sync with boid-visualizer.html)

    Per-voice stream — channel = boid.rank + 1  (1..15, low voice = channel 1)
      CC 102   curPitch    0..127
      CC 103   srcPitch    0..127   the held note this voice orbits
      CC 104   energy      0..127   (energy * 127)
      CC 105   direction   0 = down, 64 = held, 127 = up
      CC 106   fired       0 = silent step, else the ornament velocity 1..127
                           ^ sent LAST — the visualiser treats it as the commit
                             marker that ends this voice's frame.

    Global stream — channel 16
      CC 110   voice count      0..15
      CC 111   parameter index  into TELEMETRY_PARAMS
      CC 112   parameter value  0..127, normalised over the param's own range
                                ^ sent after CC 111; the pair is the commit.
      CC 113   flock event      0 = reset / all voices gone
      CC 114   tempo            round(BPM / 2), so 0..254 BPM

  The whole parameter block is re-broadcast every 4 beats, so a visualiser that
  connects mid-performance catches up on its own without the user touching a
  knob. That periodic dump — plus the CC 111/112 pair fired from
  ParameterChanged() — is what keeps the visualiser correct when parameters or
  the chord change mid-flight, which is precisely what no amount of offline
  analysis of the recorded MIDI could ever recover.
==============================================================================*/
var Telemetry = (function () {

    var GLOBAL_CH = 16;
    var MAX_VOICES = 15;                 // channel 16 is reserved for the global stream

    var CC_PITCH = 102, CC_SRC = 103, CC_ENERGY = 104, CC_DIR = 105, CC_FIRE = 106;
    var CC_VOICES = 110, CC_PARAM_IDX = 111, CC_PARAM_VAL = 112, CC_EVENT = 113, CC_TEMPO = 114;

    var SYNC_BEATS = 4;                  // full re-broadcast interval
    var lastSync = -1e9;

    // Index -> parameter, with the range needed to normalise it to 0..127.
    // The visualiser mirrors this table; order is the protocol, so append only.
    var PARAMS = [
        { name: "Movement Intensity",       min: 0,   max: 1   },
        { name: "Separation Strength",      min: 0,   max: 1   },
        { name: "Cohesion Strength",        min: 0,   max: 1   },
        { name: "Alignment Strength",       min: 0,   max: 1   },
        { name: "Scale",                    min: 0,   max: 12  },
        { name: "Key",                      min: 0,   max: 11  },
        { name: "Chord-Tone Preference",    min: 0,   max: 1   },
        { name: "Tension Probability",      min: 0,   max: 1   },
        { name: "Max Interval (semitones)", min: 1,   max: 12  },
        { name: "Register Range (± oct)",   min: 0,   max: 3   },
        { name: "Voice Crossing",           min: 0,   max: 1   },
        { name: "Update Rate",              min: 0,   max: 6   },
        { name: "Ornament Density",         min: 0,   max: 1   },
        { name: "Note Length",              min: 0.1, max: 1.5 },
        { name: "Velocity Scale",           min: 0.2, max: 1.2 },
        { name: "Humanize",                 min: 0,   max: 1   }
    ];

    function cc(number, value, channel) {
        var e = new ControlChange();
        e.number = number;
        e.value = Math.max(0, Math.min(127, Math.round(value)));
        e.channel = channel;
        e.send();
    }

    // Reset() can fire before the UI exists, so never let this throw.
    function on() {
        try { return GetParameter("Telemetry") === 1; } catch (e) { return false; }
    }

    function sendParam(i) {
        var p = PARAMS[i];
        cc(CC_PARAM_IDX, i, GLOBAL_CH);
        cc(CC_PARAM_VAL, ((GetParameter(p.name) - p.min) / (p.max - p.min)) * 127, GLOBAL_CH);
    }

    // One voice's complete state for this step — including the steps the
    // Ornament Density gate silences, which is the whole point.
    function voice(b, firedVel) {
        var ch = b.rank + 1;
        if (ch > MAX_VOICES) return;
        cc(CC_PITCH,  b.curPitch, ch);
        cc(CC_SRC,    b.srcPitch, ch);
        cc(CC_ENERGY, b.energy * 127, ch);
        cc(CC_DIR,    b.dir > 0 ? 127 : (b.dir < 0 ? 0 : 64), ch);
        cc(CC_FIRE,   firedVel, ch);
    }

    function flockSize(n) {
        if (on()) cc(CC_VOICES, Math.min(n, MAX_VOICES), GLOBAL_CH);
    }

    function paramChanged(name) {
        if (!on()) return;
        for (var i = 0; i < PARAMS.length; i++) {
            if (PARAMS[i].name === name) { sendParam(i); return; }
        }
    }

    function reset() {
        lastSync = -1e9;                 // Clock.reset() rewinds the beat, so must this
        if (on()) cc(CC_EVENT, 0, GLOBAL_CH);
    }

    function sync(beat, tempo, n) {
        if (!on() || beat - lastSync < SYNC_BEATS) return;
        lastSync = beat;
        cc(CC_TEMPO, tempo / 2, GLOBAL_CH);
        cc(CC_VOICES, Math.min(n, MAX_VOICES), GLOBAL_CH);
        for (var i = 0; i < PARAMS.length; i++) sendParam(i);
    }

    return { voice: voice, flockSize: flockSize, paramChanged: paramChanged,
             reset: reset, sync: sync };
})();

/*==============================================================================
  MODULE: MidiIn — HandleMIDI: the incoming chord is used ONLY to drive the
  boids; it is NOT forwarded to the audio engine. The plugin outputs nothing
  but the ornament notes the flock generates.
==============================================================================*/
var boids = [];                 // active voices, one per held note
var heldPitches = {};           // pitch -> true, the sustaining original chord

function rerank() {
    var sorted = boids.slice().sort(function (a, b) { return a.srcPitch - b.srcPitch; });
    for (var i = 0; i < sorted.length; i++) sorted[i].rank = i;
}

function addBoid(pitch, velocity, channel) {
    // Ensure the note graph exists before the first ProcessMIDI() runs.
    Music.rebuild(GetParameter("Key"), GetParameter("Scale"));
    var b = new Boid(pitch, velocity, channel);
    b.nextFireBeat = Clock.now() + b.phase * (RATE_BEATS[RATE_NAMES[GetParameter("Update Rate")]] || 0.25);
    boids.push(b);
    rerank();
    Telemetry.flockSize(boids.length);
}

function removeBoid(pitch, channel) {
    for (var i = boids.length - 1; i >= 0; i--) {
        if (boids[i].srcPitch === pitch && boids[i].channel === channel) {
            MidiOut.silence(boids[i]);
            boids.splice(i, 1);
        }
    }
    rerank();
    Telemetry.flockSize(boids.length);
}

function HandleMIDI(event) {
    if (event instanceof NoteOn && event.velocity > 0) {
        heldPitches[event.pitch] = true;
        addBoid(event.pitch, event.velocity, event.channel);
        // Original chord is forwarded only when "Pass Through Chord" is On,
        // so you can layer ornaments over the sustained harmony.
        if (GetParameter("Pass Through Chord") === 1) event.send();
    } else if (event instanceof NoteOff || (event instanceof NoteOn && event.velocity === 0)) {
        delete heldPitches[event.pitch];
        removeBoid(event.pitch, event.channel);
        // Always forward note-offs so a mid-hold toggle can't strand a note.
        event.send();
    } else {
        event.send();                        // pass through pedals, CCs, pitch-bend, etc.
    }
}

/*==============================================================================
  MODULE: Engine — ProcessMIDI: run the clock and schedule each voice
==============================================================================*/
function ProcessMIDI() {
    var info = GetTimingInfo();
    Clock.advance(info);

    // Ahead of the early return, so a visualiser still sees the flock empty out.
    Telemetry.sync(Clock.now(), Clock.getTempo(), boids.length);

    if (!boids.length) return;

    var cfg = Params.snapshot();
    Music.rebuild(cfg.key, cfg.scale);

    var ctx = Flock.context(boids);
    var now = Clock.now();

    for (var i = 0; i < boids.length; i++) {
        var b = boids[i];
        var guard = 0;                       // cap catch-up work per block
        while (now >= b.nextFireBeat && guard++ < 4) {
            Flock.step(b, boids, ctx, cfg);  // move through the note graph

            // Sparse, per-voice ornamentation. The voice still MOVED on a silent
            // step — telemetry reports it either way, which is exactly the part
            // the recorded MIDI can never show.
            var firedVel = (Rng.next() < cfg.density) ? MidiOut.ornament(b, cfg) : 0;
            if (cfg.telemetry) Telemetry.voice(b, firedVel);

            // Per-voice, slightly humanised interval keeps voices from locking up.
            var jitter = 1 + (Rng.next() - 0.5) * cfg.humanize * 0.5;
            b.nextFireBeat += cfg.rateBeats * jitter;
        }
    }

    if (DEBUG) Trace("boids=" + boids.length + " beat=" + now.toFixed(2));
}

/*==============================================================================
  Housekeeping
==============================================================================*/
function reseed() {
    // Reset() can fire before the UI exists, so tolerate GetParameter throwing.
    var s = 0;
    try { s = Math.round(GetParameter("Seed (0 = random)")); } catch (e) { s = 0; }
    if (s > 0) Rng.seed(Math.imul(s, 2654435761));   // deterministic run
    else       Rng.randomize();                      // a fresh stream every reset
}

function ParameterChanged(index, value) {
    // Keep the note graph in step when the key/scale is changed live.
    Music.rebuild(GetParameter("Key"), GetParameter("Scale"));

    var p = PluginParameters[index];
    if (!p) return;
    if (p.name === "Seed (0 = random)") reseed();

    // Push the change straight out, so a visualiser tracks live knob moves
    // rather than waiting up to 4 beats for the periodic re-broadcast.
    Telemetry.paramChanged(p.name);
}

function Reset() {
    for (var i = 0; i < boids.length; i++) MidiOut.silence(boids[i]);
    boids = [];
    heldPitches = {};
    Clock.reset();
    reseed();
    Telemetry.reset();
    if (typeof MIDI !== "undefined" && MIDI.allNotesOff) MIDI.allNotesOff();
}
