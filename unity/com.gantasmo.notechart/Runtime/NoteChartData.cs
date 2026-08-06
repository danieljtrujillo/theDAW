using System;

namespace Gantasmo.NoteChart
{
    /// <summary>
    /// Mirror of the gantasmo.notechart schema (schemaVersion 1) exported by
    /// theDAW's SCORE tab (POST /api/notation/{entry}/export with format
    /// "unity").
    ///
    /// Shaped for UnityEngine.JsonUtility: the root is an object, every array is
    /// a named field of [Serializable] classes, and there is no dictionary, no
    /// union type and no polymorphism. The writer guarantees no JSON null
    /// anywhere, which matters because JsonUtility maps null onto a string field
    /// as a null reference rather than "". Newtonsoft is only transitively
    /// present in this project (see Gantasmo.DawRemote.DawJson for the same
    /// call), so JsonUtility is the contract.
    ///
    /// All time and musical-position values are double. "Beats" always means
    /// quarter-note lengths regardless of meter; ChartEvent.beatInMeasure is the
    /// meter-aware notated beat and is a different quantity.
    /// </summary>
    [Serializable]
    public class NoteChart
    {
        public const string ExpectedSchema = "gantasmo.notechart";
        public const int SupportedVersion = 1;

        public string schema = "";
        public int schemaVersion;
        public string generator = "";
        public string generatedAtUtc = "";

        public ChartSource source = new ChartSource();
        public ChartAudio audio = new ChartAudio();
        public ChartTiming timing = new ChartTiming();
        public ChartQuantization quantization = new ChartQuantization();

        public TempoChange[] tempoMap = new TempoChange[0];
        public TimeSignatureChange[] timeSignatureMap = new TimeSignatureChange[0];
        public KeySignatureChange[] keySignatureMap = new KeySignatureChange[0];
        public MeasureMark[] measures = new MeasureMark[0];
        public ChartPart[] parts = new ChartPart[0];
        public ChartStats stats = new ChartStats();

        public bool IsUsable =>
            schema == ExpectedSchema && schemaVersion == SupportedVersion && parts != null && parts.Length > 0;

        /// <summary>
        /// Beats (quarter lengths) to seconds across the piecewise-constant
        /// tempo map. This is the same integration the Python exporter used to
        /// compute every onsetSec, so both sides agree exactly rather than
        /// drifting apart at the second tempo change.
        /// </summary>
        public double SecondsFromBeats(double beats)
        {
            if (tempoMap == null || tempoMap.Length == 0) return beats * 0.5; // 120 bpm floor
            int i = 0;
            for (int k = 0; k < tempoMap.Length; k++)
            {
                if (tempoMap[k].timeBeats <= beats) i = k;
                else break;
            }
            TempoChange t = tempoMap[i];
            double bpm = t.bpm > 0 ? t.bpm : 120.0;
            return t.timeSec + (beats - t.timeBeats) * 60.0 / bpm;
        }

        /// <summary>Seconds to beats (quarter lengths). Inverse of SecondsFromBeats.</summary>
        public double BeatsFromSeconds(double seconds)
        {
            if (tempoMap == null || tempoMap.Length == 0) return seconds * 2.0;
            int i = 0;
            for (int k = 0; k < tempoMap.Length; k++)
            {
                if (tempoMap[k].timeSec <= seconds) i = k;
                else break;
            }
            TempoChange t = tempoMap[i];
            double bpm = t.bpm > 0 ? t.bpm : 120.0;
            return t.timeBeats + (seconds - t.timeSec) * bpm / 60.0;
        }

        /// <summary>Quarter-note BPM in force at a given second.</summary>
        public double BpmAt(double seconds)
        {
            if (tempoMap == null || tempoMap.Length == 0) return 120.0;
            double bpm = tempoMap[0].bpm;
            for (int k = 0; k < tempoMap.Length; k++)
            {
                if (tempoMap[k].timeSec <= seconds) bpm = tempoMap[k].bpm;
                else break;
            }
            return bpm > 0 ? bpm : 120.0;
        }

        /// <summary>Total hit-bearing events across every part, for pool sizing and scoring totals.</summary>
        public int CountHitBearing()
        {
            int n = 0;
            if (parts == null) return 0;
            for (int p = 0; p < parts.Length; p++)
            {
                ChartEvent[] events = parts[p] != null ? parts[p].events : null;
                if (events == null) continue;
                for (int e = 0; e < events.Length; e++)
                    if (events[e] != null && events[e].IsHitBearing) n++;
            }
            return n;
        }
    }

    [Serializable]
    public class ChartSource
    {
        public string entryId = "";
        public string sourceArtifactId = "";
        public string sourcePath = "";
        public string sourceFormat = "";
        public string rawMidiArtifactId = "";
        public string title = "";
        public string artist = "";
        public string composer = "";
    }

    [Serializable]
    public class ChartAudio
    {
        /// <summary>Backend-relative route, e.g. /api/library/audio/{entryId}.</summary>
        public string url = "";
        public string filename = "";
        public string mimeType = "";
        public int sampleRate;
        public double durationSec;
    }

    [Serializable]
    public class ChartTiming
    {
        public string beatUnit = "quarter";
        public int ticksPerQuarter = 480;
        public double durationSec;
        public double durationBeats;
        public int totalMeasures;
        public double pickupBeats;

        /// <summary>Added to every onset to align chart zero with audio zero.</summary>
        public double audioOffsetSec;
    }

    [Serializable]
    public class ChartQuantization
    {
        public int gridDivisionsPerQuarter = 4;
        public string gridLabel = "1/16";
        public double gridSeconds;
        public bool tripletsAllowed;
        public string engine = "";

        /// <summary>True when onsetSecRaw is a copy of onsetSec and carries no extra information.</summary>
        public bool rawIsQuantized;

        public string rawSource = "";
        public int matchedRawEvents;
        public int unmatchedRawEvents;
        public double maxRawDeviationSec;
        public double meanAbsRawDeviationSec;
    }

    [Serializable]
    public class TempoChange
    {
        public double timeSec;
        public double timeBeats;
        public long timeTicks;

        /// <summary>Quarter notes per minute, never the notated referent.</summary>
        public double bpm;

        public double secPerBeat;
        public int measure;
        public bool interpolateToNext;
    }

    [Serializable]
    public class TimeSignatureChange
    {
        public int measure;
        public double timeSec;
        public double timeBeats;
        public int numerator;
        public int denominator;

        /// <summary>normal | common | cut.</summary>
        public string symbol = "normal";

        /// <summary>Bar length in quarter lengths, so 6/8 is 3.0.</summary>
        public double beatsPerBar;

        public string glyphNumerator = "";
        public int glyphNumeratorCodepoint;
        public string glyphDenominator = "";
        public int glyphDenominatorCodepoint;
    }

    [Serializable]
    public class KeySignatureChange
    {
        public int measure;
        public double timeSec;
        public double timeBeats;

        /// <summary>MusicXML convention: negative flats, positive sharps.</summary>
        public int fifths;

        public string mode = "";
        public string tonic = "";
        public string accidentalGlyph = "";
        public int accidentalCodepoint;
        public int accidentalCount;
    }

    [Serializable]
    public class MeasureMark
    {
        public int number;
        public double timeSec;
        public double timeBeats;
        public double durationBeats;
        public bool isPickup;
        public string barlineGlyph = "";
        public int barlineCodepoint;
        public bool startsRepeat;
        public bool endsRepeat;
    }

    [Serializable]
    public class ChartClef
    {
        public int measure;
        public int staff;
        public double timeSec;
        public double timeBeats;
        public string sign = "G";
        public int line = 2;
        public int octaveChange;

        /// <summary>
        /// Diatonic note number of the bottom staff line (music21 Clef.lowestLine:
        /// treble 31, bass 19, alto 25, tenor 23). staffStep is measured from it,
        /// so a runtime transposition can be re-engraved without a clef table.
        /// </summary>
        public int lowestLineDiatonic = 31;

        public string glyph = "";
        public int glyphCodepoint;
    }

    [Serializable]
    public class ChartPart
    {
        public int index;
        public string id = "";
        public string name = "";
        public string abbreviation = "";
        public string instrumentName = "";

        /// <summary>-1 when the source declares none, which is what arrangements give.</summary>
        public int midiProgram = -1;

        public int midiChannel;
        public int staffCount = 1;
        public bool isPercussion;
        public int transposeSemitones;
        public ChartClef[] clefs = new ChartClef[0];
        public ChartEvent[] events = new ChartEvent[0];

        /// <summary>Clef in force at a chart time, for staff-step recomputation. Null when the part declares none.</summary>
        public ChartClef ClefAt(double timeSec)
        {
            if (clefs == null || clefs.Length == 0) return null;
            ChartClef active = clefs[0];
            for (int i = 0; i < clefs.Length; i++)
            {
                if (clefs[i].timeSec <= timeSec) active = clefs[i];
                else break;
            }
            return active;
        }
    }

    /// <summary>
    /// One note or one rest. Rests share the class (isRest) rather than living
    /// in a parallel array, so a spawner walks a single monotonic cursor and the
    /// visual rhythm cannot desynchronise through a merge bug.
    /// </summary>
    [Serializable]
    public class ChartEvent
    {
        /// <summary>
        /// Above this actual count a tuplet is treated as a quantizer artifact
        /// rather than a playable figure. Live transcriptions in this project
        /// produce 12:11 and 12:7 groups that no player can strike; they are
        /// still drawn, but judging them would guarantee misses.
        /// </summary>
        public const int MaxJudgeableTupletActual = 9;

        public int id;
        public bool isRest;

        // Timing. Quantized values drive layout and animation; raw values are
        // the recording's truth and drive hit judging (see the chart's
        // quantization block for how far apart they ran on this export).
        public double onsetSec;
        public double onsetSecRaw;
        public double onsetBeats;
        public double onsetBeatsRaw;
        public long onsetTicks;
        public double durationSec;
        public double durationSecRaw;
        public double durationBeats;
        public long durationTicks;

        // Position in the notation.
        public int measure;

        /// <summary>Meter-aware notated beat, 1-based. NOT interchangeable with onsetBeats.</summary>
        public double beatInMeasure;

        public int voice;
        public int staff;

        // Pitch. Spelling is mandatory: MIDI 63 is D#4 or Eb4, which are
        // different glyphs at different staff positions.
        public int midi;
        public int velocity;
        public string step = "";
        public int octave;
        public int alter;

        /// <summary>Printed accidental only, so key-implied alterations draw nothing. alter stays populated regardless.</summary>
        public string accidental = "";

        public bool accidentalIsCautionary;
        public int diatonicNoteNum;

        /// <summary>0 = bottom staff line, 1 = first space, 8 = top line, negative below.</summary>
        public int staffStep;

        public int ledgerLines;
        public bool ledgerBelow;

        // Rhythm spelling.
        public string noteType = "quarter";
        public int dots;
        public bool isTuplet;
        public int tupletActual;
        public int tupletNormal;
        public string tupletBracket = "";
        public bool isGrace;

        // Engraving relationships.
        public string tie = "";
        public string beam = "";
        public int beamDepth;
        public string stemDirection = "";
        public int chordId = -1;
        public bool isChordRoot;

        // SMuFL hints. glyph is the composite (notehead + stem + flag) when one
        // exists, otherwise the bare notehead or the rest.
        public string glyph = "";
        public int glyphCodepoint;
        public string noteheadGlyph = "";
        public int noteheadCodepoint;
        public string flagGlyph = "";
        public int flagCodepoint;
        public string accidentalGlyph = "";
        public int accidentalCodepoint;
        public string dotGlyph = "";
        public int dotCodepoint;

        /// <summary>True for a tie continuation or release, which sounds inside an earlier attack.</summary>
        public bool IsTieTail => tie == "continue" || tie == "stop";

        /// <summary>
        /// True for a tuplet the quantizer invented rather than one a performer
        /// played, judged by the actual count and by whether the normal count is
        /// a power of two (or 3, which covers duplets and quadruplets in
        /// compound meter). 12:11 and 12:7 fail; 3:2, 5:4, 7:4, 9:8 pass.
        /// </summary>
        public bool IsIrrationalTuplet
        {
            get
            {
                if (!isTuplet || tupletActual <= 0 || tupletNormal <= 0) return false;
                if (tupletActual > MaxJudgeableTupletActual) return true;
                if (tupletNormal == 3) return false;
                return (tupletNormal & (tupletNormal - 1)) != 0;
            }
        }

        /// <summary>
        /// Whether this event is its own attack that a player can strike. Rests,
        /// tie tails, grace notes and quantizer-invented tuplets are all drawn,
        /// because removing them breaks the rhythm the eye reads, but none of
        /// them is scored: a tie tail would double the count on every sustained
        /// chord, and a grace note lands inside another note's window.
        /// </summary>
        public bool IsHitBearing => !isRest && !isGrace && !IsTieTail && !IsIrrationalTuplet;
    }

    [Serializable]
    public class ChartStats
    {
        public int partCount;
        public int noteCount;
        public int restCount;
        public int chordCount;
        public int tupletCount;
        public int graceCount;
        public int tiedCount;
        public int measureCount;
        public int clampedDurations;
        public double densityNotesPerSec;

        /// <summary>Peak simultaneous events. Sizes the spawner's object pool.</summary>
        public int maxSimultaneous;
    }
}
