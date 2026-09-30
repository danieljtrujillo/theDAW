#include "vst3_module.h"

#include <windows.h>

#include <algorithm>
#include <cstring>

#include "pluginterfaces/vst/ivstaudioprocessor.h"  // kVstAudioEffectClass

namespace thedaw::vst3 {
namespace {

using InitDllProc = bool(PLUGIN_API*)();
using ExitDllProc = bool(PLUGIN_API*)();
using GetFactoryProc = Steinberg::IPluginFactory*(PLUGIN_API*)();

// The subfolder a 64-bit Windows VST3 bundle keeps its binary in. Fixed by the VST3 layout.
constexpr const wchar_t* kWinArchFolder = L"Contents\\x86_64-win";

std::wstring widen(const std::string& utf8) {
    if (utf8.empty()) return {};
    const int needed =
        MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<std::size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

std::string narrow(const std::wstring& wide) {
    if (wide.empty()) return {};
    const int needed = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                           nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return {};
    std::string out(static_cast<std::size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), needed,
                        nullptr, nullptr);
    return out;
}

std::wstring normalizeSeparators(std::wstring path) {
    std::replace(path.begin(), path.end(), L'/', L'\\');
    while (path.size() > 1 && path.back() == L'\\') path.pop_back();
    return path;
}

bool pathExists(const std::wstring& path, bool& isDirectory) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) return false;
    isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    return true;
}

std::wstring fileNameOf(const std::wstring& path) {
    const std::size_t slash = path.find_last_of(L'\\');
    return slash == std::wstring::npos ? path : path.substr(slash + 1);
}

std::wstring directoryOf(const std::wstring& path) {
    const std::size_t slash = path.find_last_of(L'\\');
    return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

// First *.vst3 file in `folder`, for bundles whose inner binary is not named after the bundle.
std::wstring firstVst3In(const std::wstring& folder) {
    WIN32_FIND_DATAW found{};
    const HANDLE handle = FindFirstFileW((folder + L"\\*.vst3").c_str(), &found);
    if (handle == INVALID_HANDLE_VALUE) return {};
    std::wstring result;
    do {
        if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
            result = folder + L"\\" + found.cFileName;
            break;
        }
    } while (FindNextFileW(handle, &found));
    FindClose(handle);
    return result;
}

std::wstring resolveBinaryW(const std::wstring& input) {
    bool isDirectory = false;
    if (!pathExists(input, isDirectory)) return {};
    if (!isDirectory) return input;

    const std::wstring archFolder = input + L"\\" + kWinArchFolder;
    bool archIsDirectory = false;
    if (!pathExists(archFolder, archIsDirectory) || !archIsDirectory) return {};

    // Normal case: the binary carries the bundle's own name.
    const std::wstring preferred = archFolder + L"\\" + fileNameOf(input);
    bool preferredIsDirectory = false;
    if (pathExists(preferred, preferredIsDirectory) && !preferredIsDirectory) return preferred;

    return firstVst3In(archFolder);
}

std::string lastErrorText(DWORD code) {
    LPWSTR buffer = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
    std::string text;
    if (length > 0 && buffer != nullptr) {
        std::wstring wide(buffer, length);
        while (!wide.empty() && (wide.back() == L'\r' || wide.back() == L'\n')) wide.pop_back();
        text = narrow(wide);
    }
    if (buffer != nullptr) LocalFree(buffer);
    if (text.empty()) text = "error " + std::to_string(static_cast<unsigned long>(code));
    return text;
}

// Adds the plugin's own folder to the DLL search path for the duration of the LoadLibrary call.
// Plugins routinely ship helper DLLs next to the binary (and in Contents\Resources); without
// this they fail to load with a bare "module not found".
class ScopedDllDirectory {
public:
    explicit ScopedDllDirectory(const std::wstring& folder) {
        if (folder.empty()) return;
        cookie_ = AddDllDirectory(folder.c_str());
    }
    ~ScopedDllDirectory() {
        if (cookie_ != nullptr) RemoveDllDirectory(cookie_);
    }
    ScopedDllDirectory(const ScopedDllDirectory&) = delete;
    ScopedDllDirectory& operator=(const ScopedDllDirectory&) = delete;

private:
    DLL_DIRECTORY_COOKIE cookie_ = nullptr;
};

}  // namespace

std::string resolveVst3Binary(const std::string& pluginPath) {
    return narrow(resolveBinaryW(normalizeSeparators(widen(pluginPath))));
}

Module::~Module() {
    // Order matters and is not negotiable: the factory reference has to go before the module's
    // exit hook runs, and the library can only be unmapped once the plugin has torn down its
    // globals. Doing it the other way round is a reliable crash on exit.
    factory_.reset();
    if (library_ != nullptr) {
        const HMODULE handle = static_cast<HMODULE>(library_);
        if (auto* exitDll = reinterpret_cast<ExitDllProc>(
                reinterpret_cast<void*>(GetProcAddress(handle, "ExitDll")))) {
            exitDll();
        }
        FreeLibrary(handle);
        library_ = nullptr;
    }
}

std::shared_ptr<Module> Module::load(const std::string& pluginPath, std::string& error,
                                     int& exitCodeHint) {
    error.clear();
    exitCodeHint = 0;

    const std::wstring requested = normalizeSeparators(widen(pluginPath));
    if (requested.empty()) {
        error = "no plugin path given";
        exitCodeHint = 3;
        return nullptr;
    }
    const std::wstring binary = resolveBinaryW(requested);
    if (binary.empty()) {
        error = "no VST3 binary at " + pluginPath +
                " (expected either a DLL or a bundle with Contents\\x86_64-win inside)";
        exitCodeHint = 3;
        return nullptr;
    }

    const std::wstring folder = directoryOf(binary);
    HMODULE handle = nullptr;
    {
        // Plugins ship helper DLLs beside the binary, so its own folder has to be searchable.
        // The modern way is AddDllDirectory plus the LOAD_LIBRARY_SEARCH_* set; those flags are
        // mutually exclusive with LOAD_WITH_ALTERED_SEARCH_PATH, and mixing the two is an
        // outright ERROR_INVALID_PARAMETER rather than a fallback.
        ScopedDllDirectory searchPath(folder);
        handle = LoadLibraryExW(binary.c_str(), nullptr,
                                LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
                                    LOAD_LIBRARY_SEARCH_USER_DIRS);
    }
    if (handle == nullptr) {
        // Some older plugins only resolve their dependencies through the legacy search order,
        // which the flags above deliberately switch off. Give them that one chance.
        handle = LoadLibraryExW(binary.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    }
    if (handle == nullptr) {
        const DWORD code = GetLastError();
        error = "LoadLibrary failed for " + narrow(binary) + ": " + lastErrorText(code) +
                " (a 32-bit plugin, or a missing dependency next to it, both look like this)";
        exitCodeHint = 4;
        return nullptr;
    }

    std::shared_ptr<Module> module(new Module());
    module->library_ = handle;
    module->binaryPath_ = narrow(binary);

    // Optional on Windows, but when a plugin exports it, skipping it leaves the plugin's
    // globals uninitialised and GetPluginFactory can return garbage.
    if (auto* initDll = reinterpret_cast<InitDllProc>(
            reinterpret_cast<void*>(GetProcAddress(handle, "InitDll")))) {
        if (!initDll()) {
            error = "InitDll refused to initialise " + module->binaryPath_;
            exitCodeHint = 4;
            return nullptr;
        }
    }

    auto* getFactory = reinterpret_cast<GetFactoryProc>(
        reinterpret_cast<void*>(GetProcAddress(handle, "GetPluginFactory")));
    if (getFactory == nullptr) {
        error = module->binaryPath_ + " exports no GetPluginFactory, so it is not a VST3 plugin";
        exitCodeHint = 4;
        return nullptr;
    }
    Steinberg::IPluginFactory* rawFactory = getFactory();
    if (rawFactory == nullptr) {
        error = module->binaryPath_ + " returned a null plugin factory";
        exitCodeHint = 4;
        return nullptr;
    }
    // GetPluginFactory hands over a reference that is already ours.
    module->factory_ = ComPtr<Steinberg::IPluginFactory>::adopt(rawFactory);

    Steinberg::PFactoryInfo factoryInfo{};
    if (module->factory_->getFactoryInfo(&factoryInfo) == Steinberg::kResultOk) {
        module->factoryVendor_ = fromAsciiField(factoryInfo.vendor, sizeof(factoryInfo.vendor));
    }
    return module;
}

void Module::setHostContext(Steinberg::FUnknown* hostContext) {
    if (!factory_) return;
    if (auto factory3 = queryFor<Steinberg::IPluginFactory3>(factory_.get())) {
        factory3->setHostContext(hostContext);
    }
}

std::vector<ClassDescription> Module::describeClasses() const {
    std::vector<ClassDescription> result;
    if (!factory_) return result;

    auto factory2 = queryFor<Steinberg::IPluginFactory2>(factory_.get());
    auto factory3 = queryFor<Steinberg::IPluginFactory3>(factory_.get());

    const Steinberg::int32 count = factory_->countClasses();
    for (Steinberg::int32 i = 0; i < count; ++i) {
        Steinberg::PClassInfo info{};
        if (factory_->getClassInfo(i, &info) != Steinberg::kResultOk) continue;

        ClassDescription description;
        std::memcpy(description.cid, info.cid, sizeof(Steinberg::TUID));
        description.identifier = cidToHex(info.cid);
        description.name = fromAsciiField(info.name, sizeof(info.name));
        description.vendor = factoryVendor_;
        description.isAudioEffect =
            std::strncmp(info.category, kVstAudioEffectClass, sizeof(info.category)) == 0;

        // The richer class-info flavours add vendor, version and the sub-category string. Ask
        // for the Unicode one first: it is the only one that gets non-ASCII plugin names right.
        if (factory3) {
            Steinberg::PClassInfoW infoW{};
            if (factory3->getClassInfoUnicode(i, &infoW) == Steinberg::kResultOk) {
                const std::string wideName = fromVstString(infoW.name, sizeof(infoW.name) / sizeof(infoW.name[0]));
                if (!wideName.empty()) description.name = wideName;
                const std::string wideVendor =
                    fromVstString(infoW.vendor, sizeof(infoW.vendor) / sizeof(infoW.vendor[0]));
                if (!wideVendor.empty()) description.vendor = wideVendor;
                description.version =
                    fromVstString(infoW.version, sizeof(infoW.version) / sizeof(infoW.version[0]));
                description.subCategories = fromAsciiField(infoW.subCategories, sizeof(infoW.subCategories));
            }
        }
        if (description.version.empty() && factory2) {
            Steinberg::PClassInfo2 info2{};
            if (factory2->getClassInfo2(i, &info2) == Steinberg::kResultOk) {
                const std::string vendor2 = fromAsciiField(info2.vendor, sizeof(info2.vendor));
                if (!vendor2.empty()) description.vendor = vendor2;
                description.version = fromAsciiField(info2.version, sizeof(info2.version));
                description.subCategories = fromAsciiField(info2.subCategories, sizeof(info2.subCategories));
            }
        }
        result.push_back(std::move(description));
    }
    return result;
}

}  // namespace thedaw::vst3
