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

      Clock   – tempo-locked, free-running beat clock (works while stopped too)
      Params  – reads all UI parameters into one config object
      Music   – scale/key graph + chord/tension analysis + constraints
      Boid    – per-voice state
      Flock   – the boid update (separation / alignment / cohesion + selection)
      MidiIn  – HandleMIDI: maintains the held chord / boid population
      MidiOut – emits the short ornament Note On/Off pairs
      Engine  – ProcessMIDI: drives the clock and schedules each voice

==============================================================================*/

var NeedsTimingInfo = true;   // required so GetTimingInfo() returns tempo/beats
var DEBUG = false;            // set true to Trace() diagnostics

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
    { name: "Humanize", type: "lin", minValue: 0, maxValue: 1, defaultValue: 0.25, numberOfSteps: 100 }
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
            humanize:    GetParameter("Humanize")
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
        this.dir         = Math.random() < 0.5 ? 1 : -1;
        this.energy      = 0.5 + Math.random() * 0.5;
        this.age         = 0;
        this.phase       = Math.random();            // desyncs voices from each other
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
    function crossingOk(c, b, boids) {
        var lo = -Infinity, hi = Infinity;
        for (var i = 0; i < boids.length; i++) {
            if (boids[i] === b) continue;
            if (boids[i].rank === b.rank - 1) lo = boids[i].curPitch;
            if (boids[i].rank === b.rank + 1) hi = boids[i].curPitch;
        }
        return c > lo && c < hi;
    }

    // Advance a single boid one step through the note graph.
    function step(b, boids, ctx, cfg) {
        b.age++;
        b.energy = clamp(b.energy + (Math.random() - 0.5) * 0.15, 0.15, 1);

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

        if (!pool.length) return;   // boxed in: hold position this tick

        // Weighted random pick keeps motion organic and non-repetitive.
        var r = Math.random() * total, chosen = pool[0];
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
    function ornament(b, cfg) {
        var hum = cfg.humanize;
        var velOsc = 0.75 + 0.25 * Math.sin(b.age * 0.5);           // gentle breathing
        var velRand = 1 - hum * 0.4 * Math.random();
        var vel = clampVel(b.srcVelocity * cfg.velScale * velOsc * velRand * b.energy);

        var on = new NoteOn();
        on.pitch = b.curPitch;
        on.velocity = vel;
        on.channel = b.channel;
        on.send();

        var lenBeats = cfg.rateBeats * cfg.noteLength * (1 - hum * 0.3 * Math.random());
        var off = new NoteOff();
        off.pitch = b.curPitch;
        off.velocity = 0;
        off.channel = b.channel;
        off.sendAfterMilliseconds(Math.max(10, Clock.beatsToMs(lenBeats)));

        b.activePitch = b.curPitch;
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
}

function removeBoid(pitch, channel) {
    for (var i = boids.length - 1; i >= 0; i--) {
        if (boids[i].srcPitch === pitch && boids[i].channel === channel) {
            MidiOut.silence(boids[i]);
            boids.splice(i, 1);
        }
    }
    rerank();
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
            if (Math.random() < cfg.density) // sparse, per-voice ornamentation
                MidiOut.ornament(b, cfg);

            // Per-voice, slightly humanised interval keeps voices from locking up.
            var jitter = 1 + (Math.random() - 0.5) * cfg.humanize * 0.5;
            b.nextFireBeat += cfg.rateBeats * jitter;
        }
    }

    if (DEBUG) Trace("boids=" + boids.length + " beat=" + now.toFixed(2));
}

/*==============================================================================
  Housekeeping
==============================================================================*/
function ParameterChanged(index, value) {
    // Keep the note graph in step when the key/scale is changed live.
    Music.rebuild(GetParameter("Key"), GetParameter("Scale"));
}

function Reset() {
    for (var i = 0; i < boids.length; i++) MidiOut.silence(boids[i]);
    boids = [];
    heldPitches = {};
    Clock.reset();
    if (typeof MIDI !== "undefined" && MIDI.allNotesOff) MIDI.allNotesOff();
}
