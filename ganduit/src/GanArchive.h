// GanArchive - minimal .gan reader for the GANduit shell.
//
// A .gan is a ZIP (manifest.json + index.html + assets) with the trailing
// archive comment "GANv1" - the same container theDAW writes in
// backend/modules/plugin/gan_file.py. At load time GANduit extracts it to a
// per-instance runtime directory and points the WebView at index.html.
//
// The implementation (GanArchive.cpp) uses miniz, which iPlug2 vendors at
// iPlug2/Dependencies/IPlug/... ; see ../README.md for the include path.
#pragma once

#include <string>

namespace ganduit {

struct GanInfo {
  std::string name;        // manifest "name"
  std::string author;      // manifest "author" (expected: "GANTASMO")
  std::string company;     // manifest "company" (expected: "GANTASMO")
  std::string entryHtml;   // absolute path to the extracted index.html
  std::string runtimeDir;  // extraction root - delete on unload
  bool ok = false;
  std::string error;       // human-readable failure reason when !ok
};

// Validate `ganPath` (the "GANv1" zip comment), read manifest.json, extract all
// entries into a fresh temp runtime dir, and return the path to index.html.
GanInfo ExtractGan(const std::string& ganPath);

// Recursively remove a previously-extracted runtime dir. Safe to call on an
// empty/!ok GanInfo.
void CleanupGan(const GanInfo& info);

}  // namespace ganduit
