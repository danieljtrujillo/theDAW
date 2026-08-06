using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace Gantasmo.NoteChart
{
    /// <summary>
    /// SMuFL glyph names and their Private Use Area codepoints, as implemented
    /// by Bravura. The chart carries both the name and the codepoint per event,
    /// so this table exists for the cases where a scene composes its own glyph
    /// (a staff line, a barline it draws itself, a clef at the head of a lane)
    /// and for SelfTest, which is the only honest way to find out whether the
    /// generated font asset actually contains what the chart asks for.
    ///
    /// Every codepoint here is in E000-ECFF. TextMeshPro's default character set
    /// is ASCII and contains none of them, so a font asset built with the wrong
    /// character set renders the whole chart as tofu with no error.
    /// </summary>
    public static class SmuflGlyphs
    {
        // Composite notes: notehead, stem and flag in one character. These are
        // the workhorses for flying notation, because one glyph is one draw call
        // and one collider.
        public const int NoteDoubleWhole = 57808;   // U+E1D0
        public const int NoteWhole = 57810;         // U+E1D2
        public const int NoteHalfUp = 57811;        // U+E1D3
        public const int NoteHalfDown = 57812;      // U+E1D4
        public const int NoteQuarterUp = 57813;     // U+E1D5
        public const int NoteQuarterDown = 57814;   // U+E1D6
        public const int Note8thUp = 57815;         // U+E1D7
        public const int Note8thDown = 57816;       // U+E1D8
        public const int Note16thUp = 57817;        // U+E1D9
        public const int Note16thDown = 57818;      // U+E1DA
        public const int Note32ndUp = 57819;        // U+E1DB
        public const int Note32ndDown = 57820;      // U+E1DC
        public const int Note64thUp = 57821;        // U+E1DD
        public const int Note64thDown = 57822;      // U+E1DE
        public const int Note128thUp = 57823;       // U+E1DF
        public const int Note128thDown = 57824;     // U+E1E0

        // Bare noteheads: chord members that share a stem, and whole notes.
        public const int NoteheadDoubleWhole = 57504; // U+E0A0
        public const int NoteheadWhole = 57506;       // U+E0A2
        public const int NoteheadHalf = 57507;        // U+E0A3
        public const int NoteheadBlack = 57508;       // U+E0A4
        public const int NoteheadXBlack = 57513;      // U+E0A9

        public const int RestDoubleWhole = 58594;   // U+E4E2
        public const int RestWhole = 58595;         // U+E4E3
        public const int RestHalf = 58596;          // U+E4E4
        public const int RestQuarter = 58597;       // U+E4E5
        public const int Rest8th = 58598;           // U+E4E6
        public const int Rest16th = 58599;          // U+E4E7
        public const int Rest32nd = 58600;          // U+E4E8
        public const int Rest64th = 58601;          // U+E4E9
        public const int Rest128th = 58602;         // U+E4EA

        public const int AccidentalFlat = 57952;        // U+E260
        public const int AccidentalNatural = 57953;     // U+E261
        public const int AccidentalSharp = 57954;       // U+E262
        public const int AccidentalDoubleSharp = 57955; // U+E263
        public const int AccidentalDoubleFlat = 57956;  // U+E264

        // Flags: only for a renderer that composes notehead + stem + flag itself.
        public const int Flag8thUp = 57920;    // U+E240
        public const int Flag8thDown = 57921;  // U+E241
        public const int Flag16thUp = 57922;   // U+E242
        public const int Flag16thDown = 57923; // U+E243
        public const int Flag32ndUp = 57924;   // U+E244
        public const int Flag32ndDown = 57925; // U+E245
        public const int Flag64thUp = 57926;   // U+E246
        public const int Flag64thDown = 57927; // U+E247

        public const int GClef = 57424;                    // U+E050
        public const int GClef8vb = 57426;                 // U+E052
        public const int CClef = 57436;                    // U+E05C
        public const int FClef = 57442;                    // U+E062
        public const int UnpitchedPercussionClef1 = 57449; // U+E069

        public const int TimeSig0 = 57472;       // U+E080, digits run to timeSig9 at U+E089
        public const int TimeSigCommon = 57482;  // U+E08A
        public const int TimeSigCutCommon = 57483; // U+E08B

        public const int BarlineSingle = 57392; // U+E030
        public const int BarlineDouble = 57393; // U+E031
        public const int BarlineFinal = 57394;  // U+E032

        public const int Staff5Lines = 57364;    // U+E014
        public const int LegerLine = 57378;      // U+E022
        public const int AugmentationDot = 57831; // U+E1E7

        static readonly Dictionary<string, int> ByName = new Dictionary<string, int>(80)
        {
            { "noteDoubleWhole", NoteDoubleWhole },
            { "noteWhole", NoteWhole },
            { "noteHalfUp", NoteHalfUp },
            { "noteHalfDown", NoteHalfDown },
            { "noteQuarterUp", NoteQuarterUp },
            { "noteQuarterDown", NoteQuarterDown },
            { "note8thUp", Note8thUp },
            { "note8thDown", Note8thDown },
            { "note16thUp", Note16thUp },
            { "note16thDown", Note16thDown },
            { "note32ndUp", Note32ndUp },
            { "note32ndDown", Note32ndDown },
            { "note64thUp", Note64thUp },
            { "note64thDown", Note64thDown },
            { "note128thUp", Note128thUp },
            { "note128thDown", Note128thDown },

            { "noteheadDoubleWhole", NoteheadDoubleWhole },
            { "noteheadWhole", NoteheadWhole },
            { "noteheadHalf", NoteheadHalf },
            { "noteheadBlack", NoteheadBlack },
            { "noteheadXBlack", NoteheadXBlack },

            { "restDoubleWhole", RestDoubleWhole },
            { "restWhole", RestWhole },
            { "restHalf", RestHalf },
            { "restQuarter", RestQuarter },
            { "rest8th", Rest8th },
            { "rest16th", Rest16th },
            { "rest32nd", Rest32nd },
            { "rest64th", Rest64th },
            { "rest128th", Rest128th },

            { "accidentalFlat", AccidentalFlat },
            { "accidentalNatural", AccidentalNatural },
            { "accidentalSharp", AccidentalSharp },
            { "accidentalDoubleSharp", AccidentalDoubleSharp },
            { "accidentalDoubleFlat", AccidentalDoubleFlat },

            { "flag8thUp", Flag8thUp },
            { "flag8thDown", Flag8thDown },
            { "flag16thUp", Flag16thUp },
            { "flag16thDown", Flag16thDown },
            { "flag32ndUp", Flag32ndUp },
            { "flag32ndDown", Flag32ndDown },
            { "flag64thUp", Flag64thUp },
            { "flag64thDown", Flag64thDown },

            { "gClef", GClef },
            { "gClef8vb", GClef8vb },
            { "cClef", CClef },
            { "fClef", FClef },
            { "unpitchedPercussionClef1", UnpitchedPercussionClef1 },

            { "timeSig0", TimeSig0 },
            { "timeSig1", TimeSig0 + 1 },
            { "timeSig2", TimeSig0 + 2 },
            { "timeSig3", TimeSig0 + 3 },
            { "timeSig4", TimeSig0 + 4 },
            { "timeSig5", TimeSig0 + 5 },
            { "timeSig6", TimeSig0 + 6 },
            { "timeSig7", TimeSig0 + 7 },
            { "timeSig8", TimeSig0 + 8 },
            { "timeSig9", TimeSig0 + 9 },
            { "timeSigCommon", TimeSigCommon },
            { "timeSigCutCommon", TimeSigCutCommon },

            { "barlineSingle", BarlineSingle },
            { "barlineDouble", BarlineDouble },
            { "barlineFinal", BarlineFinal },

            { "staff5Lines", Staff5Lines },
            { "legerLine", LegerLine },
            { "augmentationDot", AugmentationDot },
        };

        // Arming a glyph happens thousands of times per song, and
        // char.ConvertFromUtf32 allocates a fresh string every call. The chart
        // draws from a few dozen distinct codepoints, so caching them keeps the
        // spawner off the GC entirely.
        static readonly Dictionary<int, string> TextCache = new Dictionary<int, string>(80);

        /// <summary>The single character for a codepoint, or "" for 0 and out-of-range values.</summary>
        public static string ToText(int codepoint)
        {
            if (codepoint <= 0 || codepoint > 0x10FFFF) return "";
            if (codepoint >= 0xD800 && codepoint <= 0xDFFF) return "";
            if (TextCache.TryGetValue(codepoint, out string cached)) return cached;
            string s = char.ConvertFromUtf32(codepoint);
            TextCache[codepoint] = s;
            return s;
        }

        /// <summary>Codepoint for a SMuFL glyph name, or 0 when the name is unknown.</summary>
        public static int Codepoint(string glyphName)
        {
            if (string.IsNullOrEmpty(glyphName)) return 0;
            return ByName.TryGetValue(glyphName, out int cp) ? cp : 0;
        }

        /// <summary>Digit glyph for a time-signature numeral, 0-9.</summary>
        public static int TimeSigDigit(int digit)
        {
            return digit >= 0 && digit <= 9 ? TimeSig0 + digit : 0;
        }

        /// <summary>Every glyph name in the table, for tooling and diagnostics.</summary>
        public static IEnumerable<string> Names => ByName.Keys;

        /// <summary>
        /// Check the generated font asset against the whole table and log the
        /// entries it cannot render. Without this a wrong character set renders
        /// tofu silently, which looks like a spawner bug rather than a font one.
        /// Returns the number of missing glyphs.
        /// </summary>
        public static int SelfTest(TMP_FontAsset font)
        {
            if (font == null)
            {
                Debug.LogWarning("[NoteChart] SmuflGlyphs.SelfTest called with no font asset.");
                return ByName.Count;
            }

            var missing = new List<string>();
            foreach (KeyValuePair<string, int> entry in ByName)
                if (!font.HasCharacter(entry.Value))
                    missing.Add($"{entry.Key} (U+{entry.Value:X4})");

            if (missing.Count == 0)
            {
                Debug.Log($"[NoteChart] SMuFL self-test passed: '{font.name}' renders all {ByName.Count} glyphs.");
                return 0;
            }

            Debug.LogWarning($"[NoteChart] SMuFL self-test: '{font.name}' is missing {missing.Count} of " +
                             $"{ByName.Count} glyphs. Rebuild the font asset with character set " +
                             $"'Unicode Range (Hex)' covering E000-ECFF. Missing: {string.Join(", ", missing)}");
            return missing.Count;
        }
    }
}
