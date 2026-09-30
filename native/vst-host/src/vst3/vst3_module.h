// Loading a .vst3 off disk and getting at its class factory.
//
// A "VST3 plugin" on Windows is one of two things:
//   * a bundle directory  X.vst3/Contents/x86_64-win/X.vst3   (the binary is the inner file)
//   * a bare DLL          X.vst3
// Both are handled. The module owns the HMODULE and the factory, and unwinds them in the only
// order that is safe: drop the factory reference, call ExitDll, then FreeLibrary.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "pluginterfaces/base/ipluginbase.h"

#include "vst3_common.h"

namespace thedaw::vst3 {

struct ClassDescription {
    std::string name;
    std::string vendor;
    std::string version;
    std::string subCategories;
    std::string identifier;  // 32 hex characters
    Steinberg::TUID cid{};
    bool isAudioEffect = false;
};

class Module {
public:
    ~Module();

    Module(const Module&) = delete;
    Module& operator=(const Module&) = delete;

    // `pluginPath` is the bundle directory or the DLL. On failure returns nullptr and fills
    // `error`; `exitCodeHint` is 3 when nothing is there to load and 4 when loading failed.
    static std::shared_ptr<Module> load(const std::string& pluginPath, std::string& error,
                                        int& exitCodeHint);

    Steinberg::IPluginFactory* factory() const { return factory_.get(); }
    const std::string& binaryPath() const { return binaryPath_; }
    const std::string& factoryVendor() const { return factoryVendor_; }

    // Every class the factory advertises, audio effects flagged.
    std::vector<ClassDescription> describeClasses() const;

    // Lets the plugin's factory see our IHostApplication before anything is instantiated.
    void setHostContext(Steinberg::FUnknown* hostContext);

private:
    Module() = default;

    void* library_ = nullptr;  // HMODULE, kept void* so this header stays free of windows.h
    ComPtr<Steinberg::IPluginFactory> factory_;
    std::string binaryPath_;
    std::string factoryVendor_;
};

// Resolve a bundle path to the binary inside it. Returns an empty string when there is no
// readable binary at `pluginPath`.
std::string resolveVst3Binary(const std::string& pluginPath);

}  // namespace thedaw::vst3
