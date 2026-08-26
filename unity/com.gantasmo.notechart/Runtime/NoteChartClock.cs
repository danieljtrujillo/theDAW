using System;
using UnityEngine;

namespace Gantasmo.NoteChart
{
    /// <summary>
    /// Song position for a locally played chart.
    ///
    /// Position comes from AudioSettings.dspTime, the audio hardware clock,
    /// against a start instant fixed by AudioSource.PlayScheduled, so it is
    /// absolute, monotonic and free of accumulated drift for the whole song.
    /// AudioSource.time is deliberately not used: it reports the mixer read
    /// position sampled at a frame boundary, so it advances in DSP block steps
    /// (11 ms on desktop, 21 ms on the headset at typical buffer sizes), can
    /// repeat across consecutive frames, and can step backwards after an
    /// underrun, which scatters spawn instants across a block boundary.
    /// Time.time is not used either: it is frame time, so it hitches with the
    /// renderer and slews against playback over the length of a song.
    ///
    /// Because dspTime only ticks once per DSP block, SongTime advances at frame
    /// rate between ticks and resynchronises on every tick, so motion is smooth
    /// while staying locked to the hardware clock.
    ///
    /// Before the scheduled start SongTime is negative, which is the count-in:
    /// notes whose spawn time is negative fly in during the lead-in, which is
    /// exactly what should happen for a chart whose first note is at t=0.
    ///
    /// DawBeatClock in com.gantasmo.songpacks uses Time.unscaledTimeAsDouble for
    /// the opposite reason: it extrapolates a remote DAW grid with no local
    /// audio and a protocol carrying no timestamps. Here the audio is local, so
    /// the better clock is available. The two coexist.
    /// </summary>
    [AddComponentMenu("GANTASMO Note Chart/Note Chart Clock")]
    [DisallowMultipleComponent]
    [RequireComponent(typeof(AudioSource))]
    public class NoteChartClock : MonoBehaviour
    {
        /// <summary>Static accessor: the spawner and any scoring code query this per frame.</summary>
        public static NoteChartClock Instance { get; private set; }

        [Tooltip("Audio source playing the chart's track. Taken from this GameObject if empty.")]
        [SerializeField] AudioSource source;

        [Tooltip("Seconds of DSP lead granted to PlayScheduled so the mixer has time to prime.")]
        [Range(0.05f, 1f)] public double scheduleLeadSec = 0.25;

        [Tooltip("Per-headset latency calibration. Positive values make notes arrive later.")]
        [Range(-0.25f, 0.25f)] public double calibrationOffsetSec = 0.0;

        [Tooltip("Silence before the first note so the count-in is visible.")]
        [Range(0f, 8f)] public double countInSec = 2.0;

        /// <summary>Song position in seconds. Negative during the count-in.</summary>
        public double SongTime => _smoothed - calibrationOffsetSec;

        /// <summary>True once PlayFromStart has been called and Stop has not.</summary>
        public bool IsRunning { get; private set; }

        /// <summary>True once the audio's scheduled start instant has passed.</summary>
        public bool AudioStarted => IsRunning && AudioSettings.dspTime >= _dspStart;

        /// <summary>The audio source the clock schedules. Null only before Awake.</summary>
        public AudioSource Source => source;

        /// <summary>Fired on the main thread the first frame the audio actually starts.</summary>
        public event Action Started;

        double _dspStart;
        double _lastDsp;
        double _smoothed;
        bool _firedStarted;

        void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Debug.LogWarning("[NoteChart] Duplicate NoteChartClock, keeping the first.", this);
                return;
            }
            Instance = this;
            if (source == null) source = GetComponent<AudioSource>();
            if (source != null) source.playOnAwake = false;
        }

        void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <summary>Hand the clock the track to schedule. Stops playback if it was running.</summary>
        public void SetClip(AudioClip clip)
        {
            if (source == null) source = GetComponent<AudioSource>();
            if (source == null)
            {
                Debug.LogWarning("[NoteChart] No AudioSource on the clock, clip ignored.", this);
                return;
            }
            if (IsRunning) Stop();
            source.clip = clip;
        }

        /// <summary>
        /// Schedule the track and start the clock. The clock begins at
        /// -(countInSec) so the first notes have time to fly in.
        /// </summary>
        public void PlayFromStart()
        {
            if (source == null || source.clip == null)
            {
                Debug.LogWarning("[NoteChart] PlayFromStart with no AudioSource clip, clock idle.", this);
                return;
            }
            if (!Mathf.Approximately(source.pitch, 1f))
            {
                // dspTime maps to song position one-to-one only at unit pitch;
                // any other rate silently detunes the whole chart.
                Debug.LogWarning($"[NoteChart] AudioSource.pitch is {source.pitch}, dspTime mapping assumes 1.0. " +
                                 "Resetting to 1.0 so the chart stays in sync.", this);
                source.pitch = 1f;
            }

            double now = AudioSettings.dspTime;
            _dspStart = now + scheduleLeadSec + countInSec;
            source.Stop();
            source.time = 0f;
            source.PlayScheduled(_dspStart);

            _lastDsp = now;
            _smoothed = now - _dspStart;   // negative: the count-in
            _firedStarted = false;
            IsRunning = true;
        }

        public void Stop()
        {
            if (source != null) source.Stop();
            IsRunning = false;
            _firedStarted = false;
            _smoothed = 0;
        }

        void Update()
        {
            if (!IsRunning) return;

            double dsp = AudioSettings.dspTime;
            if (dsp > _lastDsp)
            {
                // The DSP block ticked: resynchronise to the hardware clock.
                _lastDsp = dsp;
                _smoothed = dsp - _dspStart;
            }
            else
            {
                // Between blocks: advance at frame rate so motion stays smooth,
                // but never run past where the next tick can place us, or a
                // 120 Hz frame rate would outrun a 21 ms block and then jerk
                // backwards on every resync.
                _smoothed += Time.unscaledDeltaTime;
                double ceiling = (_lastDsp - _dspStart) + BlockSeconds;
                if (_smoothed > ceiling) _smoothed = ceiling;
            }

            if (!_firedStarted && _smoothed >= 0)
            {
                _firedStarted = true;
                Started?.Invoke();
            }
        }

        static double BlockSeconds
        {
            get
            {
                AudioConfiguration cfg = AudioSettings.GetConfiguration();
                return cfg.sampleRate > 0 ? (double)cfg.dspBufferSize / cfg.sampleRate : 0.021;
            }
        }
    }
}
