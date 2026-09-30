// The two free functions IPluginInstance.h declares for the VST3 side: listing what is inside a
// .vst3 file, and creating an instance of one of its audio-effect classes.
#include <algorithm>
#include <cctype>
#include <memory>
#include <string>
#include <vector>

#include "../plugin/IPluginInstance.h"

#include "vst3_common.h"
#include "vst3_host_context.h"
#include "vst3_iid_log.h"
#include "vst3_instance.h"
#include "vst3_module.h"

namespace thedaw {
namespace {

PluginInfo toPluginInfo(const vst3::ClassDescription& description, const std::string& fallbackVendor) {
    PluginInfo info;
    info.name = description.name;
    info.vendor = description.vendor.empty() ? fallbackVendor : description.vendor;
    info.version = description.version;
    info.category = description.subCategories;
    info.identifier = description.identifier;
    info.format = "VST3";
    return info;
}

// Case-insensitive, because nobody types a plugin name with the vendor's capitalisation.
bool namesMatch(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i) {
        const char ca = static_cast<char>(
            std::tolower(static_cast<unsigned char>(a[i])));
        const char cb = static_cast<char>(
            std::tolower(static_cast<unsigned char>(b[i])));
        if (ca != cb) return false;
    }
    return true;
}

}  // namespace

PluginListing listVst3Plugins(const std::string& pluginPath) {
    PluginListing listing;
    std::string error;
    int exitCodeHint = 0;
    std::shared_ptr<vst3::Module> module = vst3::Module::load(pluginPath, error, exitCodeHint);
    if (!module) {
        listing.ok = false;
        listing.error = error;
        listing.exitCodeHint = exitCodeHint;
        return listing;
    }
    for (const vst3::ClassDescription& description : module->describeClasses()) {
        if (!description.isAudioEffect) continue;
        listing.plugins.push_back(toPluginInfo(description, module->factoryVendor()));
    }
    listing.ok = true;
    return listing;
}

PluginLoadResult createVst3Plugin(const std::string& pluginPath, const std::string& pluginName,
                                  const std::string& classIdHex, IPluginEvents* events) {
    PluginLoadResult result;
    std::string error;
    int exitCodeHint = 0;

    std::shared_ptr<vst3::Module> module = vst3::Module::load(pluginPath, error, exitCodeHint);
    if (!module) {
        result.error = error;
        result.exitCodeHint = exitCodeHint;
        return result;
    }

    std::vector<vst3::ClassDescription> effects;
    for (const vst3::ClassDescription& description : module->describeClasses()) {
        if (description.isAudioEffect) effects.push_back(description);
    }
    if (effects.empty()) {
        result.error = pluginPath + " contains no audio-effect class";
        result.exitCodeHint = 4;
        return result;
    }

    const vst3::ClassDescription* chosen = nullptr;
    if (!classIdHex.empty()) {
        std::string wanted = classIdHex;
        std::transform(wanted.begin(), wanted.end(), wanted.begin(), [](unsigned char c) {
            return static_cast<char>(std::toupper(c));
        });
        for (const vst3::ClassDescription& description : effects) {
            if (description.identifier == wanted) {
                chosen = &description;
                break;
            }
        }
        if (chosen == nullptr) {
            result.error = "no audio-effect class with id " + classIdHex + " in " + pluginPath;
            result.exitCodeHint = 4;
            return result;
        }
    } else if (!pluginName.empty()) {
        for (const vst3::ClassDescription& description : effects) {
            if (namesMatch(description.name, pluginName)) {
                chosen = &description;
                break;
            }
        }
        if (chosen == nullptr) {
            std::string available;
            for (const vst3::ClassDescription& description : effects) {
                if (!available.empty()) available += ", ";
                available += description.name;
            }
            result.error = "no plugin named '" + pluginName + "' in " + pluginPath +
                           " (it contains: " + available + ")";
            result.exitCodeHint = 4;
            return result;
        }
    } else {
        chosen = &effects.front();
        if (effects.size() > 1) {
            std::string available;
            for (const vst3::ClassDescription& description : effects) {
                if (!available.empty()) available += ", ";
                available += description.name;
            }
            result.warnings.push_back("this file holds " + std::to_string(effects.size()) +
                                      " audio effects (" + available + "); loading '" +
                                      chosen->name + "'. Pass a name or class id to pick another");
        }
    }

    auto instance = std::make_unique<vst3::Vst3Instance>(module, events);
    // The factory has to see our host context before anything is instantiated, or plugins that
    // ask the host for services during construction get nothing.
    module->setHostContext(instance->hostContext());
    std::string initError;
    if (!instance->initialize(*chosen, initError, result.warnings)) {
        result.error = initError;
        result.exitCodeHint = 4;
        return result;
    }
    result.plugin = std::move(instance);
    return result;
}

void setVst3HostName(const std::string& name) { vst3::setHostApplicationName(name); }

void setVst3IidLogging(bool on) { vst3::iidlog::setEnabled(on); }

std::vector<Vst3IidQuery> vst3IidQueries() {
    std::vector<Vst3IidQuery> out;
    for (const vst3::iidlog::Entry& entry : vst3::iidlog::entries()) {
        Vst3IidQuery query;
        query.site = entry.site;
        query.iid = entry.iid;
        query.name = entry.name;
        query.answered = entry.answered;
        query.count = entry.count;
        out.push_back(query);
    }
    return out;
}

}  // namespace thedaw
