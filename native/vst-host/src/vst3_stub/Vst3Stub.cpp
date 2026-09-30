// Linked instead of src/vst3 when the host is configured with
// -DTHEDAW_VST3=OFF. Every entry point answers honestly rather than pretending
// to work, so `--list` and a real --plugin run fail with a message that names
// the missing build option.

#include <windows.h>

#include "../plugin/IPluginInstance.h"
#include "../util/StringUtil.h"

namespace thedaw {
namespace {

const char kNotBuilt[] =
    "VST3 layer not built (configure with -DTHEDAW_VST3=ON and rebuild)";

bool pluginFileMissing(const std::string& pluginPath) {
    const std::wstring wide = util::utf8ToWide(pluginPath);
    if (wide.empty()) return true;
    // A .vst3 bundle is a directory; a legacy single-file module is not.
    const DWORD attributes = GetFileAttributesW(wide.c_str());
    return attributes == INVALID_FILE_ATTRIBUTES;
}

}  // namespace

PluginListing listVst3Plugins(const std::string& pluginPath) {
    PluginListing listing;
    listing.ok = false;
    if (pluginFileMissing(pluginPath)) {
        listing.error = "plugin file not found: " + pluginPath;
        listing.exitCodeHint = 3;
        return listing;
    }
    listing.error = kNotBuilt;
    listing.exitCodeHint = 4;
    return listing;
}

PluginLoadResult createVst3Plugin(const std::string& pluginPath,
                                  const std::string& pluginName,
                                  const std::string& classIdHex, IPluginEvents* events) {
    (void)pluginName;
    (void)classIdHex;
    (void)events;
    PluginLoadResult result;
    if (pluginFileMissing(pluginPath)) {
        result.error = "plugin file not found: " + pluginPath;
        result.exitCodeHint = 3;
        return result;
    }
    result.error = kNotBuilt;
    result.exitCodeHint = 4;
    return result;
}

void setVst3HostName(const std::string& name) { (void)name; }

void setVst3IidLogging(bool on) { (void)on; }

std::vector<Vst3IidQuery> vst3IidQueries() { return {}; }

}  // namespace thedaw
