using TMPro;
using UnityEngine;

namespace Gantasmo.NoteChart
{
    /// <summary>
    /// One notation glyph in flight.
    ///
    /// Position is recomputed every frame from absolute song time rather than
    /// integrated with deltaTime, so a dropped frame, a pause or a seek cannot
    /// introduce drift: the glyph is always exactly where its hit time says it
    /// should be, and at songTime == HitTime it is on the hit plane.
    ///
    /// Instances are pooled by NoteChartSpawner and re-armed rather than
    /// destroyed, so nothing here may allocate per frame.
    /// </summary>
    [AddComponentMenu("GANTASMO Note Chart/Flying Note")]
    [DisallowMultipleComponent]
    public class FlyingNote : MonoBehaviour
    {
        [Tooltip("TextMeshPro renderer carrying the SMuFL glyph. Found in children if empty.")]
        [SerializeField] TMP_Text glyphText;

        [Tooltip("Accidental drawn to the left of the notehead. Optional; hidden when the event prints none.")]
        [SerializeField] TMP_Text accidentalText;

        /// <summary>The chart event this glyph is showing, null while pooled.</summary>
        public ChartEvent Event { get; private set; }

        /// <summary>Song time at which this glyph reaches the hit plane.</summary>
        public double HitTime { get; private set; }

        /// <summary>Set once the note has been scored or has passed the plane, so it is not counted twice.</summary>
        public bool Judged { get; set; }

        Vector3 _hitPoint;
        Vector3 _approachDir;   // unit vector from the hit point back toward the spawn point
        float _speed;

        void Awake()
        {
            EnsureRefs();
        }

        // Pooled instances are armed while still inactive, so Awake has not
        // necessarily run yet and the inactive search has to be explicit.
        void EnsureRefs()
        {
            if (glyphText == null) glyphText = GetComponentInChildren<TMP_Text>(true);
        }

        /// <summary>
        /// Arm the glyph. hitPoint already carries the staff-step height and the
        /// part's lane offset; approachDir points from hitPoint back to spawn.
        /// facing is computed once by the spawner because it is the same for
        /// every glyph on the lane. songTime places the glyph correctly on its
        /// first frame, so it appears at the spawn anchor rather than at the
        /// origin.
        /// </summary>
        public void Arm(ChartEvent ev, double hitTime, double songTime, Vector3 hitPoint,
                        Vector3 approachDir, Quaternion facing, float speed, Color color)
        {
            EnsureRefs();

            Event = ev;
            HitTime = hitTime;
            Judged = false;
            _hitPoint = hitPoint;
            _approachDir = approachDir;
            _speed = speed;

            if (glyphText != null)
            {
                glyphText.text = SmuflGlyphs.ToText(ev.glyphCodepoint);
                glyphText.color = color;
            }
            if (accidentalText != null)
            {
                bool hasAccidental = ev.accidentalCodepoint != 0;
                accidentalText.gameObject.SetActive(hasAccidental);
                if (hasAccidental)
                {
                    accidentalText.text = SmuflGlyphs.ToText(ev.accidentalCodepoint);
                    accidentalText.color = color;
                }
            }

            transform.rotation = facing;
            gameObject.SetActive(true);
            UpdatePosition(songTime);
        }

        /// <summary>
        /// Absolute placement. The remaining seconds before the hit set the
        /// distance still to travel, so the glyph lands on the hit plane at
        /// exactly songTime == HitTime.
        /// </summary>
        public void UpdatePosition(double songTime)
        {
            double remaining = HitTime - songTime;
            float distance = (float)(remaining * _speed);
            transform.position = _hitPoint + _approachDir * distance;
        }

        public void Retire()
        {
            Event = null;
            gameObject.SetActive(false);
        }
    }
}
