using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Gantasmo.NoteChart.EditorTools
{
    /// <summary>
    /// GANTASMO menu entries for the note-chart rig. Idempotent, mirroring the
    /// DAW Remote and Song Packs setup scripts: re-running selects the existing
    /// rig instead of duplicating it.
    /// </summary>
    public static class NoteChartSetup
    {
        const string RootName = "GANTASMO Note Chart";

        [MenuItem("GANTASMO/Note Chart/Build Rig In Scene", false, 90)]
        public static void BuildRig()
        {
            var existing = Object.FindAnyObjectByType<NoteChartSpawner>();
            if (existing != null)
            {
                Selection.activeGameObject = existing.gameObject;
                Debug.Log("[NoteChart] Rig already in the scene, selected it.");
                return;
            }

            var root = new GameObject(RootName);
            Undo.RegisterCreatedObjectUndo(root, "Build Note Chart Rig");

            var audio = root.AddComponent<AudioSource>();
            audio.playOnAwake = false;
            audio.spatialBlend = 0f;      // the track is the score, not a point source
            var clock = root.AddComponent<NoteChartClock>();
            var loader = root.AddComponent<NoteChartLoader>();
            root.AddComponent<StaffLayout>();
            var spawner = root.AddComponent<NoteChartSpawner>();

            // The hit plane sits just in front of the player; the spawn anchor's
            // distance from it is what sets the lead-in time at a given speed.
            var hit = new GameObject("Hit Anchor");
            hit.transform.SetParent(root.transform, false);
            hit.transform.localPosition = new Vector3(0f, 1.4f, 0.9f);

            var spawn = new GameObject("Spawn Anchor");
            spawn.transform.SetParent(root.transform, false);
            spawn.transform.localPosition = new Vector3(0f, 1.4f, 24.9f);

            GameObject template = BuildGlyphTemplate(root.transform);

            Assign(clock, "source", audio);
            Assign(loader, "clock", clock);
            Assign(spawner, "clock", clock);
            Assign(spawner, "loader", loader);
            Assign(spawner, "spawnAnchor", spawn.transform);
            Assign(spawner, "hitAnchor", hit.transform);
            Assign(spawner, "notePrefab", template.GetComponent<FlyingNote>());

            Selection.activeGameObject = root;
            EditorSceneManager.MarkSceneDirty(root.scene);
            Debug.Log("[NoteChart] Rig built: clock (AudioSettings.dspTime), loader, spawner, staff layout, " +
                      "spawn and hit anchors, and a pooled glyph template. Next: assign the Bravura TMP font " +
                      "asset on 'Flying Note Template/Glyph' (see the package README for how to generate it, " +
                      "character set Unicode Range (Hex) E000-ECFF), then point the loader at a chart by " +
                      "artifact id or drop the .unity.json into StreamingAssets. Defaults reach theDAW at " +
                      "127.0.0.1:8600 over the backend's adb-reverse USB tunnel.");
        }

        /// <summary>
        /// The pooled source object. It stays inactive in the scene rather than
        /// becoming a prefab asset, so the menu item writes nothing into the
        /// project; Instantiate clones a scene object just as happily.
        /// </summary>
        static GameObject BuildGlyphTemplate(Transform parent)
        {
            var template = new GameObject("Flying Note Template");
            template.transform.SetParent(parent, false);
            template.AddComponent<FlyingNote>();

            var glyph = new GameObject("Glyph");
            glyph.transform.SetParent(template.transform, false);
            var text = glyph.AddComponent<TextMeshPro>();
            text.text = "";
            text.fontSize = 4f;
            text.alignment = TextAlignmentOptions.Center;

            var accidental = new GameObject("Accidental");
            accidental.transform.SetParent(template.transform, false);
            accidental.transform.localPosition = new Vector3(-0.08f, 0f, 0f);
            var accidentalText = accidental.AddComponent<TextMeshPro>();
            accidentalText.text = "";
            accidentalText.fontSize = 4f;
            accidentalText.alignment = TextAlignmentOptions.Center;
            accidental.SetActive(false);

            var note = template.GetComponent<FlyingNote>();
            Assign(note, "glyphText", text);
            Assign(note, "accidentalText", accidentalText);

            template.SetActive(false);
            return template;
        }

        static void Assign(Object target, string fieldName, Object value)
        {
            var so = new SerializedObject(target);
            SerializedProperty prop = so.FindProperty(fieldName);
            if (prop == null)
            {
                Debug.LogWarning($"[NoteChart] Setup could not find serialized field '{fieldName}' on {target.GetType().Name}.");
                return;
            }
            prop.objectReferenceValue = value;
            so.ApplyModifiedPropertiesWithoutUndo();
        }
    }
}
