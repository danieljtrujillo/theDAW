// GanArchive - .gan (ZIP + "GANv1" comment) reader via miniz.
//
// SCAFFOLD: miniz ships with iPlug2 (Dependencies/Extras/nanovg... varies by
// version) or can be added as a single-file dep. Adjust the include below to the
// pinned location once the project is generated. Cannot be compiled in theDAW's
// Python/Node env.
#include "GanArchive.h"

#include <cstdio>
#include <filesystem>
#include <fstream>

// One of these will resolve once miniz is on the include path; keep both so the
// project compiles whether miniz is vendored or system-installed.
#if __has_include("miniz.h")
  #include "miniz.h"
#elif __has_include(<miniz.h>)
  #include <miniz.h>
#else
  #error "GanArchive needs miniz.h - see ganduit/README.md (Dependencies)."
#endif

namespace fs = std::filesystem;

namespace ganduit {

namespace {

// Extremely small manifest field reader (avoids pulling a JSON lib into the
// scaffold). A real build should use the JSON lib iPlug2 already vendors.
std::string ReadJsonString(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  auto k = json.find(needle);
  if (k == std::string::npos) return "";
  auto colon = json.find(':', k + needle.size());
  if (colon == std::string::npos) return "";
  auto q1 = json.find('"', colon + 1);
  if (q1 == std::string::npos) return "";
  auto q2 = json.find('"', q1 + 1);
  if (q2 == std::string::npos) return "";
  return json.substr(q1 + 1, q2 - q1 - 1);
}

}  // namespace

GanInfo ExtractGan(const std::string& ganPath) {
  GanInfo out;
  if (ganPath.empty() || !fs::exists(ganPath)) {
    out.error = "gan file not found";
    return out;
  }

  mz_zip_archive zip{};
  if (!mz_zip_reader_init_file(&zip, ganPath.c_str(), 0)) {
    out.error = "not a readable zip";
    return out;
  }

  // Fresh per-instance runtime dir under the system temp.
  std::error_code ec;
  fs::path root = fs::temp_directory_path(ec) / ("ganduit_" + fs::path(ganPath).stem().string());
  fs::remove_all(root, ec);
  fs::create_directories(root, ec);

  const mz_uint count = mz_zip_reader_get_num_files(&zip);
  std::string manifest;
  for (mz_uint i = 0; i < count; i++) {
    mz_zip_archive_file_stat st;
    if (!mz_zip_reader_file_stat(&zip, i, &st)) continue;
    const std::string name = st.m_filename;
    if (name.empty() || name.back() == '/') continue;  // directory entry

    // zip-slip guard: keep the destination inside root.
    fs::path dest = (root / name).lexically_normal();
    if (dest.string().rfind(root.lexically_normal().string(), 0) != 0) continue;
    fs::create_directories(dest.parent_path(), ec);

    size_t size = 0;
    void* data = mz_zip_reader_extract_to_heap(&zip, i, &size, 0);
    if (!data) continue;
    std::ofstream f(dest, std::ios::binary);
    f.write(static_cast<const char*>(data), static_cast<std::streamsize>(size));
    if (name == "manifest.json") manifest.assign(static_cast<const char*>(data), size);
    mz_free(data);
  }
  mz_zip_reader_end(&zip);

  fs::path index = root / "index.html";
  if (!fs::exists(index)) {
    out.error = "index.html missing from .gan";
    return out;
  }

  out.name = ReadJsonString(manifest, "name");
  out.author = ReadJsonString(manifest, "author");
  out.company = ReadJsonString(manifest, "company");
  out.entryHtml = index.string();
  out.runtimeDir = root.string();
  out.ok = true;
  return out;
}

void CleanupGan(const GanInfo& info) {
  if (info.runtimeDir.empty()) return;
  std::error_code ec;
  fs::remove_all(info.runtimeDir, ec);
}

}  // namespace ganduit
