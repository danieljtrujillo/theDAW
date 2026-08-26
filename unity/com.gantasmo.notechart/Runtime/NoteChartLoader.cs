using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace Gantasmo.NoteChart
{
    /// <summary>
    /// Resolves a gantasmo.notechart document and the track it belongs to, then
    /// hands both to the clock and the spawner.
    ///
    /// Sources are tried in order: an inspector TextAsset, StreamingAssets,
    /// persistentDataPath, then theDAW's backend over HTTP. The backend default
    /// is 127.0.0.1:8600, which rides the adb-reverse USB tunnel theDAW's
    /// questmidi module already opens, so a tethered headset needs no network
    /// setup (the same default DawControlBusClient uses). For Wi-Fi, set the
    /// desktop's LAN IP in the inspector.
    ///
    /// Parsing is JsonUtility, matching Gantasmo.DawRemote's documented call:
    /// Newtonsoft is only transitively present in this project, so nothing here
    /// may depend on it. The chart is rejected outright when its schema name or
    /// version does not match, because a silently mismatched chart produces
    /// notes in the wrong places rather than an error.
    /// </summary>
    [AddComponentMenu("GANTASMO Note Chart/Note Chart Loader")]
    [DisallowMultipleComponent]
    public class NoteChartLoader : MonoBehaviour
    {
        [Header("Sources, tried in order")]
        [Tooltip("Chart JSON dropped straight into the scene. Wins over every other source.")]
        [SerializeField] TextAsset chartAsset;

        [Tooltip("File name looked for under StreamingAssets and then persistentDataPath.")]
        public string fileName = "notechart.unity.json";

        [Tooltip("theDAW artifact id of the chart, fetched from the backend when no file is found.")]
        public string artifactId = "";

        [Header("Backend")]
        [Tooltip("Desktop address. 127.0.0.1 rides the adb-reverse USB tunnel; " +
                 "set the desktop's LAN IP for Wi-Fi instead.")]
        public string host = "127.0.0.1";

        [Tooltip("theDAW backend HTTP port.")]
        public int port = 8600;

        [Header("Audio")]
        [Tooltip("Fetch the chart's track from the backend and hand it to the clock.")]
        public bool fetchAudio = true;

        [Tooltip("Song clock to hand the clip to. Auto-found if left empty.")]
        [SerializeField] NoteChartClock clock;

        [Tooltip("Start playing as soon as the chart and its audio are both ready.")]
        public bool playWhenReady = true;

        [Header("Startup")]
        [Tooltip("Begin loading in Start. Turn off to trigger Load() from your own code.")]
        public bool loadOnStart = true;

        /// <summary>The parsed chart, null until one loads.</summary>
        public NoteChart Chart { get; private set; }

        /// <summary>True while a load is in flight.</summary>
        public bool IsLoading { get; private set; }

        /// <summary>Fired on the main thread once a chart has parsed and validated.</summary>
        public event Action<NoteChart> ChartLoaded;

        /// <summary>Fired on the main thread once the track is on the clock.</summary>
        public event Action<AudioClip> AudioLoaded;

        /// <summary>Base URL of theDAW backend.</summary>
        public string BaseUrl => $"http://{host}:{port}";

        void Start()
        {
            if (loadOnStart) Load();
        }

        /// <summary>Resolve the chart from the first source that answers.</summary>
        public void Load()
        {
            if (IsLoading) return;
            StartCoroutine(LoadRoutine());
        }

        IEnumerator LoadRoutine()
        {
            IsLoading = true;
            string json = null;
            string origin = "";

            if (chartAsset != null && !string.IsNullOrEmpty(chartAsset.text))
            {
                json = chartAsset.text;
                origin = $"TextAsset '{chartAsset.name}'";
            }

            if (json == null && !string.IsNullOrEmpty(fileName))
            {
                // StreamingAssets lives inside the APK on Android, so it can only
                // be read through UnityWebRequest, never through File.
                string streaming = Path.Combine(Application.streamingAssetsPath, fileName);
                yield return ReadTextRoutine(ToUri(streaming), text =>
                {
                    if (text != null) { json = text; origin = streaming; }
                });
            }

            if (json == null && !string.IsNullOrEmpty(fileName))
            {
                string persistent = Path.Combine(Application.persistentDataPath, fileName);
                if (File.Exists(persistent))
                {
                    string text = null;
                    try
                    {
                        text = File.ReadAllText(persistent);
                    }
                    catch (Exception e)
                    {
                        Debug.LogWarning($"[NoteChart] Could not read {persistent}: {e.Message}", this);
                    }
                    if (!string.IsNullOrEmpty(text)) { json = text; origin = persistent; }
                }
            }

            if (json == null && !string.IsNullOrEmpty(artifactId))
            {
                string url = $"{BaseUrl}/api/notation/file/{artifactId}";
                yield return ReadTextRoutine(url, text =>
                {
                    if (text != null) { json = text; origin = url; }
                });
            }

            if (string.IsNullOrEmpty(json))
            {
                Debug.LogWarning($"[NoteChart] No chart found. Looked for '{fileName}' under StreamingAssets " +
                                 $"and {Application.persistentDataPath}" +
                                 (string.IsNullOrEmpty(artifactId) ? " (no artifactId set)." : $", then {BaseUrl}."),
                                 this);
                IsLoading = false;
                yield break;
            }

            NoteChart chart = Parse(json, origin);
            if (chart == null)
            {
                IsLoading = false;
                yield break;
            }

            Chart = chart;
            Debug.Log($"[NoteChart] Loaded '{chart.source.title}' from {origin}: " +
                      $"{chart.stats.noteCount} note(s), {chart.stats.restCount} rest(s), " +
                      $"{chart.CountHitBearing()} judgeable, {chart.timing.durationSec:0.0}s, " +
                      $"grid {chart.quantization.gridLabel}" +
                      (chart.quantization.rawIsQuantized
                          ? ", raw onsets unavailable (judging falls back to the engraved grid)."
                          : $", raw deviation mean {chart.quantization.meanAbsRawDeviationSec * 1000.0:0.0}ms " +
                            $"max {chart.quantization.maxRawDeviationSec * 1000.0:0.0}ms."));
            ChartLoaded?.Invoke(chart);

            if (fetchAudio && !string.IsNullOrEmpty(chart.audio.url))
                yield return LoadAudioRoutine(chart);

            IsLoading = false;
        }

        NoteChart Parse(string json, string origin)
        {
            NoteChart chart;
            try
            {
                chart = JsonUtility.FromJson<NoteChart>(json);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[NoteChart] {origin} is not valid JSON: {e.Message}", this);
                return null;
            }
            if (chart == null)
            {
                Debug.LogWarning($"[NoteChart] {origin} parsed to nothing.", this);
                return null;
            }
            if (chart.schema != NoteChart.ExpectedSchema)
            {
                Debug.LogWarning($"[NoteChart] {origin} declares schema '{chart.schema}', " +
                                 $"expected '{NoteChart.ExpectedSchema}'. Refusing it.", this);
                return null;
            }
            if (chart.schemaVersion != NoteChart.SupportedVersion)
            {
                Debug.LogWarning($"[NoteChart] {origin} is schemaVersion {chart.schemaVersion}, " +
                                 $"this package supports {NoteChart.SupportedVersion}. Refusing it: a " +
                                 "mismatched chart places notes wrongly instead of failing.", this);
                return null;
            }
            if (chart.parts == null || chart.parts.Length == 0)
            {
                Debug.LogWarning($"[NoteChart] {origin} carries no parts.", this);
                return null;
            }

            // The exporter never writes JSON null, but a hand-edited chart can,
            // and JsonUtility maps null onto a nested class field as a null
            // reference. Filling the blocks in here keeps every reader from
            // having to guard.
            if (chart.source == null) chart.source = new ChartSource();
            if (chart.audio == null) chart.audio = new ChartAudio();
            if (chart.timing == null) chart.timing = new ChartTiming();
            if (chart.quantization == null) chart.quantization = new ChartQuantization();
            if (chart.stats == null) chart.stats = new ChartStats();
            if (chart.tempoMap == null) chart.tempoMap = new TempoChange[0];
            if (chart.timeSignatureMap == null) chart.timeSignatureMap = new TimeSignatureChange[0];
            if (chart.keySignatureMap == null) chart.keySignatureMap = new KeySignatureChange[0];
            if (chart.measures == null) chart.measures = new MeasureMark[0];

            return chart;
        }

        IEnumerator LoadAudioRoutine(NoteChart chart)
        {
            string url = AbsoluteUrl(chart.audio.url);
            AudioType type = AudioTypeFor(chart.audio.mimeType, chart.audio.filename);

            using (UnityWebRequest req = UnityWebRequestMultimedia.GetAudioClip(url, type))
            {
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success)
                {
                    Debug.LogWarning($"[NoteChart] Could not fetch audio from {url}: {req.error}", this);
                    yield break;
                }

                AudioClip clip = DownloadHandlerAudioClip.GetContent(req);
                if (clip == null)
                {
                    Debug.LogWarning($"[NoteChart] {url} decoded to no clip (type {type}).", this);
                    yield break;
                }
                clip.name = string.IsNullOrEmpty(chart.audio.filename) ? "notechart" : chart.audio.filename;

                if (clock == null) clock = FindAnyObjectByType<NoteChartClock>();
                if (clock == null)
                {
                    Debug.LogWarning("[NoteChart] No NoteChartClock in the scene, audio not scheduled.", this);
                    yield break;
                }

                clock.SetClip(clip);
                AudioLoaded?.Invoke(clip);
                if (playWhenReady) clock.PlayFromStart();
            }
        }

        /// <summary>GET a text body, or null on any failure. Failures are expected while walking the source list.</summary>
        IEnumerator ReadTextRoutine(string url, Action<string> done)
        {
            using (UnityWebRequest req = UnityWebRequest.Get(url))
            {
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success)
                {
                    done(null);
                    yield break;
                }
                done(req.downloadHandler.text);
            }
        }

        /// <summary>Prefix a backend-relative route such as /api/library/audio/{id} with the host.</summary>
        public string AbsoluteUrl(string url)
        {
            if (string.IsNullOrEmpty(url)) return "";
            if (url.Contains("://")) return url;
            return url.StartsWith("/", StringComparison.Ordinal) ? BaseUrl + url : $"{BaseUrl}/{url}";
        }

        /// <summary>
        /// UnityWebRequest needs a URI. On Android StreamingAssets is already a
        /// jar: URL, everywhere else it is a plain path that has to be escaped.
        /// </summary>
        static string ToUri(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            if (path.Contains("://")) return path;
            return new Uri(path).AbsoluteUri;
        }

        /// <summary>
        /// Decoding is explicit rather than AudioType.UNKNOWN, which fails on
        /// Android for anything the extension does not give away.
        /// </summary>
        static AudioType AudioTypeFor(string mimeType, string filename)
        {
            string mime = mimeType != null ? mimeType.ToLowerInvariant() : "";
            if (mime.Contains("wav")) return AudioType.WAV;
            if (mime.Contains("ogg") || mime.Contains("vorbis")) return AudioType.OGGVORBIS;
            if (mime.Contains("mpeg") || mime.Contains("mp3")) return AudioType.MPEG;

            string ext = !string.IsNullOrEmpty(filename) ? Path.GetExtension(filename).ToLowerInvariant() : "";
            switch (ext)
            {
                case ".wav": return AudioType.WAV;
                case ".ogg": return AudioType.OGGVORBIS;
                case ".mp3": return AudioType.MPEG;
                case ".aiff":
                case ".aif": return AudioType.AIFF;
                default: return AudioType.UNKNOWN;
            }
        }
    }
}
