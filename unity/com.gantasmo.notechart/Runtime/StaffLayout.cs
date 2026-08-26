using System.Collections.Generic;
using UnityEngine;

namespace Gantasmo.NoteChart
{
    /// <summary>
    /// Turns notation coordinates into world space: staffStep into height,
    /// part into lane, staff into a vertical block within its lane.
    ///
    /// staffStep counts diatonic positions from the bottom staff line (0 = the
    /// bottom line, 1 = the first space, 8 = the top line, negative below), so
    /// one step is half a staff space and height is staffStep * space / 2. The
    /// exporter already resolved it against each part's clef, which is why a
    /// bass-clef part and a treble-clef part both read correctly against the
    /// same lane origin.
    ///
    /// Lanes are laid out along this transform's right axis and heights along
    /// its up axis, so rotating the rig carries the whole chart with it.
    /// </summary>
    [AddComponentMenu("GANTASMO Note Chart/Staff Layout")]
    [DisallowMultipleComponent]
    public class StaffLayout : MonoBehaviour
    {
        [Tooltip("Height of one staff space in metres. 0.06 puts a five-line staff at 24 cm, legible at two metres.")]
        [Range(0.01f, 0.4f)] public float staffSpaceMeters = 0.06f;

        [Tooltip("Distance between part lanes in metres.")]
        [Range(0.1f, 4f)] public float laneSpacingMeters = 0.9f;

        [Tooltip("Vertical drop from one staff to the next inside a multi-staff part, in metres.")]
        [Range(0f, 2f)] public float staffDropMeters = 0.5f;

        [Tooltip("Centre the lanes on the hit anchor instead of running them out to the right.")]
        public bool centerLanes = true;

        /// <summary>Metres per staff step: half a staff space.</summary>
        public float StepMeters => staffSpaceMeters * 0.5f;

        // Part.index is whatever the exporter assigned and need not be dense, so
        // lanes are assigned by order of appearance rather than by index value.
        readonly Dictionary<int, int> _lane = new Dictionary<int, int>();
        float _laneCentreOffset;

        /// <summary>Assign one lane per part in the chart. Safe to call again on a new chart.</summary>
        public void Configure(NoteChart chart)
        {
            _lane.Clear();
            _laneCentreOffset = 0f;
            if (chart == null || chart.parts == null) return;

            for (int i = 0; i < chart.parts.Length; i++)
            {
                ChartPart part = chart.parts[i];
                if (part == null) continue;
                if (!_lane.ContainsKey(part.index)) _lane[part.index] = _lane.Count;
            }
            if (centerLanes && _lane.Count > 1)
                _laneCentreOffset = (_lane.Count - 1) * laneSpacingMeters * 0.5f;
        }

        /// <summary>Lane ordinal for a part, 0 when the part was not in the configured chart.</summary>
        public int LaneOf(ChartPart part)
        {
            if (part == null) return 0;
            return _lane.TryGetValue(part.index, out int lane) ? lane : 0;
        }

        /// <summary>
        /// World point an event should occupy when it lands, measured from the
        /// hit anchor. Chord members share a lane and differ only in height,
        /// because staffStep already differs between them.
        /// </summary>
        public Vector3 HitPoint(Vector3 hitOrigin, ChartPart part, ChartEvent ev)
        {
            if (ev == null) return hitOrigin;

            float height = ev.staffStep * StepMeters;
            int staffIndex = ev.staff > 1 ? ev.staff - 1 : 0;
            height -= staffIndex * staffDropMeters;

            float lateral = LaneOf(part) * laneSpacingMeters - _laneCentreOffset;

            return hitOrigin + transform.up * height + transform.right * lateral;
        }
    }
}
