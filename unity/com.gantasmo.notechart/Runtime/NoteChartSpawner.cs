using System;
using System.Collections.Generic;
using UnityEngine;

namespace Gantasmo.NoteChart
{
    /// <summary>
    /// Turns a NoteChart into engraved glyphs flying toward the player.
    ///
    /// Scheduling, stated once:
    ///
    ///   travelDistance = |spawnAnchor.position - hitAnchor.position|   (metres)
    ///   leadInSeconds  = travelDistance / approachSpeed                (seconds)
    ///   hitTime        = onset + timing.audioOffsetSec                 (song seconds)
    ///   spawnTime      = hitTime - leadInSeconds
    ///
    /// and per frame, for every live glyph:
    ///
    ///   remaining = hitTime - songTime
    ///   position  = hitPoint + approachDir * (remaining * approachSpeed)
    ///
    /// At songTime == hitTime the remaining distance is zero and the glyph is on
    /// the hit plane. Position is a pure function of song time rather than an
    /// integration, so no drift can accumulate and a pause or a seek places
    /// every live glyph correctly on the next frame.
    ///
    /// Timing comes from NoteChartClock (AudioSettings.dspTime). Layout uses the
    /// quantized onset so beams and bar groupings read as notation; judging uses
    /// ChartEvent.onsetSecRaw, which is where the recording actually hits. On a
    /// 1/16 grid at 120 BPM the two are up to 62.5 ms apart, which is wider than
    /// any rhythm game's perfect window, so judging against the engraved value
    /// would score a musically perfect strike as a miss.
    ///
    /// Glyphs are pooled. A chart routinely carries thousands of events, and
    /// per-note Instantiate stutters visibly on a headset.
    /// </summary>
    [AddComponentMenu("GANTASMO Note Chart/Note Chart Spawner")]
    [DisallowMultipleComponent]
    public class NoteChartSpawner : MonoBehaviour
    {
        public enum TimingSource
        {
            /// <summary>Grid-aligned. Beams and bars read correctly. Default for visuals.</summary>
            Quantized,

            /// <summary>The recording's true onset. Correct for judging, and it keeps swing visible.</summary>
            Raw,

            /// <summary>Blend of the two, weighted by rawBlend.</summary>
            Blend,
        }

        [Header("Wiring")]
        [Tooltip("Song clock. Auto-found if left empty.")]
        [SerializeField] NoteChartClock clock;

        [Tooltip("Chart loader. Auto-found if left empty.")]
        [SerializeField] NoteChartLoader loader;

        [Tooltip("Where glyphs appear. Its distance to the hit anchor sets the lead-in time.")]
        [SerializeField] Transform spawnAnchor;

        [Tooltip("Where glyphs arrive on the beat. Usually just in front of the player.")]
        [SerializeField] Transform hitAnchor;

        [Tooltip("Pooled glyph prefab carrying a FlyingNote and a TextMeshPro using the Bravura SDF asset.")]
        [SerializeField] FlyingNote notePrefab;

        [Header("Flight")]
        [Tooltip("Approach speed in metres per second. Lead-in time is travel distance divided by this.")]
        [Range(1f, 40f)] public float approachSpeed = 8f;

        [Tooltip("Seconds a glyph keeps flying past the hit plane before it is recycled.")]
        [Range(0.05f, 2f)] public float despawnAfterSec = 0.5f;

        [Tooltip("Pool size. Size it from the chart's stats.maxSimultaneous and the lead-in time.")]
        [Range(32, 2048)] public int poolSize = 384;

        [Header("Timing policy")]
        [Tooltip("Which onset drives the visual. Quantized keeps notation legible; Raw follows the groove.")]
        public TimingSource visualTiming = TimingSource.Quantized;

        [Tooltip("Raw weight when visualTiming is Blend. 0 is fully quantized, 1 is fully raw.")]
        [Range(0f, 1f)] public float rawBlend = 0.5f;

        [Header("Content")]
        [Tooltip("Spawn rests as well as notes. Without them the visual rhythm reads wrong.")]
        public bool spawnRests = true;

        [Tooltip("Spawn tie continuations and releases. They are drawn but never judged.")]
        public bool spawnTieContinuations = true;

        [Tooltip("Part indices to spawn. Empty means every part.")]
        public int[] partFilter = new int[0];

        [Header("Appearance")]
        [Tooltip("Colour for notes.")]
        public Color noteColor = Color.white;

        [Tooltip("Colour for rests and for anything drawn but not judged.")]
        public Color restColor = new Color(1f, 1f, 1f, 0.45f);

        /// <summary>Fired on the main thread when a hit-bearing note reaches the hit plane.</summary>
        public event Action<ChartEvent, double> NoteReachedHitPlane;

        struct Scheduled
        {
            public ChartEvent ev;
            public double hitTime;
            public double spawnTime;
            public Vector3 hitPoint;
            public bool judgeable;
        }

        // A backwards jump larger than this is a restart or a seek, not clock
        // smoothing, so the schedule cursor is rebuilt from scratch.
        const double SeekEpsilonSec = 0.05;

        Scheduled[] _schedule = new Scheduled[0];
        int _cursor;
        readonly List<FlyingNote> _live = new List<FlyingNote>(128);
        readonly Stack<FlyingNote> _pool = new Stack<FlyingNote>(128);
        StaffLayout _layout;
        Vector3 _approachDir = Vector3.forward;
        Quaternion _facing = Quaternion.identity;
        float _travelDistance;
        NoteChart _chart;
        double _lastSongTime = double.NegativeInfinity;

        /// <summary>Seconds a glyph spends in flight: travel distance divided by approach speed.</summary>
        public double LeadInSeconds => approachSpeed > 0f ? _travelDistance / approachSpeed : 0.0;

        /// <summary>Events currently in flight.</summary>
        public int LiveCount => _live.Count;

        /// <summary>The chart the current schedule was built from, null until one loads.</summary>
        public NoteChart Chart => _chart;

        void OnEnable()
        {
            if (clock == null) clock = FindAnyObjectByType<NoteChartClock>();
            if (loader == null) loader = FindAnyObjectByType<NoteChartLoader>();
            if (loader != null)
            {
                loader.ChartLoaded += OnChartLoaded;
                if (loader.Chart != null) OnChartLoaded(loader.Chart);
            }
        }

        void OnDisable()
        {
            if (loader != null) loader.ChartLoaded -= OnChartLoaded;
        }

        void OnChartLoaded(NoteChart chart)
        {
            _chart = chart;
            RetireAll();
            if (chart == null || !chart.IsUsable)
            {
                Debug.LogWarning("[NoteChart] Chart is missing or its schema is unsupported, spawner idle.", this);
                _schedule = new Scheduled[0];
                _cursor = 0;
                return;
            }
            if (chart.quantization.rawIsQuantized && visualTiming != TimingSource.Quantized)
                Debug.Log("[NoteChart] rawIsQuantized is set: raw onsets are copies of the quantized ones, " +
                          "so the visual timing policy has no effect on this chart.");

            Rebuild();
            Debug.Log($"[NoteChart] '{chart.source.title}': {_schedule.Length} scheduled event(s), " +
                      $"{chart.parts.Length} part(s), lead-in {LeadInSeconds:0.000}s over {_travelDistance:0.00}m.");
        }

        /// <summary>
        /// Recompute geometry, schedule and pool. Call after moving the anchors
        /// or changing approachSpeed, since both change every spawn time.
        /// </summary>
        public void Rebuild()
        {
            if (_chart == null || !_chart.IsUsable) return;
            RetireAll();
            BuildLayout(_chart);
            BuildSchedule(_chart);
            EnsurePool();
            _lastSongTime = double.NegativeInfinity;
        }

        void BuildLayout(NoteChart chart)
        {
            _layout = GetComponent<StaffLayout>();
            if (_layout == null) _layout = gameObject.AddComponent<StaffLayout>();
            _layout.Configure(chart);

            Vector3 spawn = spawnAnchor != null ? spawnAnchor.position : transform.position + transform.forward * 24f;
            Vector3 hit = hitAnchor != null ? hitAnchor.position : transform.position;
            Vector3 delta = spawn - hit;
            _travelDistance = delta.magnitude;
            _approachDir = _travelDistance > 1e-4f ? delta / _travelDistance : Vector3.forward;

            // A TMP glyph reads only from its +Z side, and the player stands in
            // the direction the notes are travelling, which is -approachDir.
            // Computed once here because it is identical for every glyph, and
            // because LookRotation misbehaves when its two vectors are parallel,
            // which happens whenever the notes fall straight down.
            Vector3 facingForward = -_approachDir;
            Vector3 upward = transform.up;
            if (Mathf.Abs(Vector3.Dot(facingForward, upward.normalized)) > 0.999f)
                upward = transform.forward;
            _facing = Quaternion.LookRotation(facingForward, upward);
        }

        void BuildSchedule(NoteChart chart)
        {
            double lead = LeadInSeconds;
            double offset = chart.timing.audioOffsetSec;
            Vector3 hitOrigin = hitAnchor != null ? hitAnchor.position : transform.position;
            var list = new List<Scheduled>(Mathf.Max(64, chart.stats.noteCount + chart.stats.restCount));

            for (int p = 0; p < chart.parts.Length; p++)
            {
                ChartPart part = chart.parts[p];
                if (part == null || !PartAllowed(part.index)) continue;

                ChartEvent[] events = part.events;
                if (events == null) continue;

                for (int e = 0; e < events.Length; e++)
                {
                    ChartEvent ev = events[e];
                    if (ev == null) continue;
                    if (ev.isRest && !spawnRests) continue;
                    if (ev.IsTieTail && !spawnTieContinuations) continue;

                    double hitTime = VisualOnset(ev, chart) + offset;
                    list.Add(new Scheduled
                    {
                        ev = ev,
                        hitTime = hitTime,
                        spawnTime = hitTime - lead,
                        hitPoint = _layout.HitPoint(hitOrigin, part, ev),
                        judgeable = ev.IsHitBearing,
                    });
                }
            }

            // One cursor covers every part at once, which is only sound if the
            // merged schedule is sorted by spawn time.
            list.Sort((a, b) => a.spawnTime.CompareTo(b.spawnTime));
            _schedule = list.ToArray();
            _cursor = 0;
        }

        bool PartAllowed(int index)
        {
            if (partFilter == null || partFilter.Length == 0) return true;
            for (int i = 0; i < partFilter.Length; i++)
                if (partFilter[i] == index) return true;
            return false;
        }

        double VisualOnset(ChartEvent ev, NoteChart chart)
        {
            if (chart.quantization.rawIsQuantized) return ev.onsetSec;
            switch (visualTiming)
            {
                case TimingSource.Raw: return ev.onsetSecRaw;
                case TimingSource.Blend: return ev.onsetSec + (ev.onsetSecRaw - ev.onsetSec) * rawBlend;
                default: return ev.onsetSec;
            }
        }

        void EnsurePool()
        {
            if (notePrefab == null)
            {
                Debug.LogWarning("[NoteChart] No FlyingNote prefab assigned, nothing will spawn.", this);
                return;
            }
            // Prewarmed in one go at load rather than during play: the hitch
            // belongs before the count-in, not on the first downbeat.
            while (_pool.Count + _live.Count < poolSize)
            {
                FlyingNote fn = Instantiate(notePrefab, transform);
                fn.gameObject.SetActive(false);
                _pool.Push(fn);
            }
        }

        void Update()
        {
            if (_chart == null || clock == null || _schedule.Length == 0) return;

            if (!clock.IsRunning)
            {
                if (_live.Count > 0) { RetireAll(); _cursor = 0; }
                _lastSongTime = double.NegativeInfinity;
                return;
            }

            double songTime = clock.SongTime;

            if (songTime < _lastSongTime - SeekEpsilonSec)
                ReseekTo(songTime);
            _lastSongTime = songTime;

            // Spawn everything whose lead-in has begun.
            while (_cursor < _schedule.Length && _schedule[_cursor].spawnTime <= songTime)
            {
                Spawn(_schedule[_cursor], songTime);
                _cursor++;
            }

            // Place and retire. Iterating backwards allows removal in place.
            for (int i = _live.Count - 1; i >= 0; i--)
            {
                FlyingNote fn = _live[i];
                double past = songTime - fn.HitTime;

                if (!fn.Judged && past >= 0.0 && fn.Event != null && fn.Event.IsHitBearing)
                {
                    fn.Judged = true;
                    NoteReachedHitPlane?.Invoke(fn.Event, fn.HitTime);
                }

                if (past > despawnAfterSec)
                {
                    fn.Retire();
                    _pool.Push(fn);
                    _live.RemoveAt(i);
                    continue;
                }
                fn.UpdatePosition(songTime);
            }
        }

        /// <summary>Rebuild the cursor and refill the sky after a restart or a seek.</summary>
        void ReseekTo(double songTime)
        {
            RetireAll();
            _cursor = 0;
            while (_cursor < _schedule.Length && _schedule[_cursor].spawnTime <= songTime)
            {
                // Only what would still be visible: everything earlier has
                // already been and gone.
                if (songTime - _schedule[_cursor].hitTime <= despawnAfterSec)
                    Spawn(_schedule[_cursor], songTime);
                _cursor++;
            }
        }

        void Spawn(Scheduled s, double songTime)
        {
            if (_pool.Count == 0)
            {
                if (notePrefab == null) return;
                // Grow rather than drop: a dropped note is a hole in the chart.
                FlyingNote extra = Instantiate(notePrefab, transform);
                extra.gameObject.SetActive(false);
                _pool.Push(extra);
                Debug.LogWarning($"[NoteChart] Pool exhausted at {poolSize}, grew by one. " +
                                 "Raise poolSize or shorten the lead-in.", this);
            }
            FlyingNote fn = _pool.Pop();
            fn.Arm(s.ev, s.hitTime, songTime, s.hitPoint, _approachDir, _facing, approachSpeed,
                   s.judgeable ? noteColor : restColor);
            _live.Add(fn);
        }

        void RetireAll()
        {
            for (int i = 0; i < _live.Count; i++)
            {
                _live[i].Retire();
                _pool.Push(_live[i]);
            }
            _live.Clear();
        }

        /// <summary>
        /// Judge a player input against the recording's true onset rather than
        /// the engraved grid, because the audio hits at the raw onset while the
        /// score is drawn at the quantized one. Returns the signed error in
        /// seconds (positive means late), or double.NaN when nothing judgeable
        /// is inside the window.
        /// </summary>
        public double JudgeAt(double inputSongTime, double windowSec, out ChartEvent hit)
        {
            hit = null;
            double best = double.NaN;
            double bestAbs = windowSec;
            bool useRaw = _chart != null && !_chart.quantization.rawIsQuantized;
            double offset = _chart != null ? _chart.timing.audioOffsetSec : 0.0;

            for (int i = 0; i < _live.Count; i++)
            {
                FlyingNote fn = _live[i];
                ChartEvent ev = fn.Event;
                if (ev == null || !ev.IsHitBearing) continue;

                double target = useRaw ? ev.onsetSecRaw + offset : fn.HitTime;
                double err = inputSongTime - target;
                double abs = Math.Abs(err);
                if (abs < bestAbs)
                {
                    bestAbs = abs;
                    best = err;
                    hit = ev;
                }
            }
            return best;
        }
    }
}
