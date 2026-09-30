// vst3_probe — drives theDAW's VST3 hosting layer against a real plugin and prints what happened
// as JSON. Everything the live host will need is exercised here first: listing, loading, bus
// negotiation, a realtime process run, state round trips and the editor window.
//
//   vst3_probe --list <path>
//   vst3_probe --load <path> [--name N | --class-id X] [--rate 48000] [--block 512]
//              [--channels 2] [--state-in F] [--set-param I=V ...] [--process-seconds S]
//              [--state-out F] [--editor-seconds S] [--host-name N] [--iid-log]
//              [--state-before-activate]
//   vst3_probe --selftest            (no plugin: pins the state container's codec)
//
// Exit codes match the host's: 0 clean, 2 bad arguments, 3 plugin file not found,
// 4 plugin failed to load or initialise, 5 unsupported bus layout.
//
// --set-param <index-or-id>=<normalized 0..1> is repeatable and applied right after the plugin
// is prepared: setParamNormalized() reaches the controller, flushParameters() then delivers the
// same edit to the processor through a zero-sample process() call, exactly as the live host
// would once audio stops flowing. Applied before the params dump and before --state-out, so both
// reflect the requested values. A malformed pair, an out-of-range value or an id/index that does
// not name a real parameter is rejected with exit code 2 and a one-line message on stderr.
#include <windows.h>
// WIN32_LEAN_AND_MEAN drops OLE from windows.h, and plugin editors need an STA.
#include <objbase.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <fstream>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "plugin/IPluginInstance.h"
#include "vst3/vst3_state_container.h"

#include "json_out.h"
#include "message_loop.h"

namespace {

using namespace thedaw;
using namespace thedaw::probe;

constexpr int kExitOk = 0;
constexpr int kExitBadArgs = 2;
constexpr int kExitNotFound = 3;
constexpr int kExitLoadFailed = 4;
constexpr int kExitBadLayout = 5;

// One "<index-or-id>=<value>" pair off the command line. Whether `id` names a parameter's index
// or its VST3 ParamID can only be resolved once the plugin's parameter list exists, so that
// happens later in runLoad(); this struct only holds what parsing itself can already validate.
struct SetParamArg {
    long long id = 0;      // the index-or-id token, already confirmed non-negative
    double value = 0.0;    // requested normalized value, already confirmed within 0..1
    std::string raw;       // original "index-or-id=value" text, for error messages
};

struct Options {
    bool list = false;
    std::string pluginPath;
    std::string name;
    std::string classId;
    double sampleRate = 48000.0;
    int blockSize = 512;
    int channels = 2;
    double processSeconds = 0.0;
    double editorSeconds = 0.0;
    std::string stateIn;
    std::string stateOut;
    std::string hostName;
    std::vector<SetParamArg> setParams;
    bool iidLog = false;
    // Capture the state before the component is activated instead of after, so the
    // state-interchange investigation can test the capture point as a hypothesis.
    bool stateBeforeActivate = false;
    // Run the state container's fixed-vector codec check and nothing else. No plugin, no COM,
    // no message thread — so it stays runnable on a machine with no plugins installed.
    bool selfTest = false;
};

void printErrorJson(const std::string& message) {
    std::printf("%s\n", jsonObject({jsonMember("ok", jsonBool(false)),
                                    jsonMember("error", jsonString(message))})
                            .c_str());
    std::fflush(stdout);
}

// Everything the plugin tells us while the probe runs. Touched on the message thread only, but
// read at the end from the same thread, so a plain mutex is enough and costs nothing that
// matters here.
class ProbeEvents final : public IPluginEvents {
public:
    void onLatencyChanged(std::int32_t latencySamples) override {
        std::lock_guard<std::mutex> lock(mutex_);
        latencyChanges_.push_back(latencySamples);
    }
    void onParamEdited(std::int32_t index, double normalizedValue) override {
        std::lock_guard<std::mutex> lock(mutex_);
        ++paramEdits_;
        lastParamIndex_ = index;
        lastParamValue_ = normalizedValue;
    }
    // The probe reports edits, not the gestures that bracket them.
    void onParamGesture(std::int32_t index, bool begin) override {
        (void)index;
        (void)begin;
    }
    void onEditorResized(std::int32_t width, std::int32_t height) override {
        std::lock_guard<std::mutex> lock(mutex_);
        sizeEvents_.push_back({width, height});
    }
    void onEditorClosed() override {
        std::lock_guard<std::mutex> lock(mutex_);
        editorClosed_ = true;
    }
    void onWarning(const std::string& text) override {
        std::lock_guard<std::mutex> lock(mutex_);
        warnings_.push_back(text);
    }
    void onRestartRequired() override {
        std::lock_guard<std::mutex> lock(mutex_);
        ++restartsRequired_;
    }

    std::vector<std::int32_t> latencyChanges() {
        std::lock_guard<std::mutex> lock(mutex_);
        return latencyChanges_;
    }
    std::vector<std::pair<std::int32_t, std::int32_t>> sizeEvents() {
        std::lock_guard<std::mutex> lock(mutex_);
        return sizeEvents_;
    }
    std::vector<std::string> warnings() {
        std::lock_guard<std::mutex> lock(mutex_);
        return warnings_;
    }
    int restartsRequired() {
        std::lock_guard<std::mutex> lock(mutex_);
        return restartsRequired_;
    }
    int paramEdits() {
        std::lock_guard<std::mutex> lock(mutex_);
        return paramEdits_;
    }
    bool editorClosed() {
        std::lock_guard<std::mutex> lock(mutex_);
        return editorClosed_;
    }

private:
    std::mutex mutex_;
    std::vector<std::int32_t> latencyChanges_;
    std::vector<std::pair<std::int32_t, std::int32_t>> sizeEvents_;
    std::vector<std::string> warnings_;
    int restartsRequired_ = 0;
    int paramEdits_ = 0;
    std::int32_t lastParamIndex_ = -1;
    double lastParamValue_ = 0.0;
    bool editorClosed_ = false;
};

bool parseDouble(const char* text, double& out) {
    try {
        std::size_t consumed = 0;
        const double value = std::stod(text, &consumed);
        if (consumed == 0) return false;
        out = value;
        return true;
    } catch (...) {
        return false;
    }
}

bool parseInt(const char* text, int& out) {
    double value = 0;
    if (!parseDouble(text, value)) return false;
    out = static_cast<int>(value);
    return true;
}

// Splits and range-checks one --set-param argument. Digits-only on the left (no sign: both an
// index and a VST3 ParamID are non-negative) and a single '=' are all this can check without a
// loaded plugin; an id/index that does not name a real parameter is caught later in runLoad().
bool parseSetParamArg(const std::string& text, SetParamArg& out, std::string& error) {
    const std::size_t eq = text.find('=');
    if (eq == std::string::npos || eq == 0 || eq + 1 >= text.size() ||
        text.find('=', eq + 1) != std::string::npos) {
        error = "--set-param wants <index-or-id>=<value>, got: " + text;
        return false;
    }
    const std::string idPart = text.substr(0, eq);
    const std::string valuePart = text.substr(eq + 1);
    for (char c : idPart) {
        if (c < '0' || c > '9') {
            error = "--set-param id/index must be a non-negative integer: " + idPart;
            return false;
        }
    }
    long long parsedId = 0;
    try {
        std::size_t consumed = 0;
        parsedId = std::stoll(idPart, &consumed);
        if (consumed != idPart.size()) {
            error = "--set-param id/index must be a non-negative integer: " + idPart;
            return false;
        }
    } catch (...) {
        error = "--set-param id/index is out of range: " + idPart;
        return false;
    }
    // A VST3 ParamID is uint32_t, and the fallback lookup in runLoad() narrows a
    // not-found index candidate to static_cast<std::uint32_t>(arg.id) before comparing it
    // against a real parameter's id. std::stoll above only rejects what does not fit in a
    // (64-bit) long long, so anything from 2^32 up would otherwise survive parsing and then
    // silently wrap during that narrowing cast (4294967296 -> 0, 4294967297 -> 1, ...).
    // Reject it here, before it can alias onto an unrelated parameter.
    if (parsedId > static_cast<long long>(std::numeric_limits<std::uint32_t>::max())) {
        error = "--set-param id/index is out of range: " + idPart;
        return false;
    }
    // Parsed inline rather than through parseDouble(): that helper only requires that
    // std::stod() consumed *something*, so "0.5abc" would parse as 0.5 and silently drop the
    // trailing garbage. A --set-param value must consume the whole token.
    double parsedValue = 0.0;
    try {
        std::size_t consumed = 0;
        parsedValue = std::stod(valuePart, &consumed);
        if (consumed != valuePart.size()) {
            error = "--set-param value must be numeric: " + valuePart;
            return false;
        }
    } catch (...) {
        error = "--set-param value must be numeric: " + valuePart;
        return false;
    }
    if (!(parsedValue >= 0.0 && parsedValue <= 1.0)) {  // catches NaN too
        error = "--set-param value must be within 0..1: " + valuePart;
        return false;
    }
    out.id = parsedId;
    out.value = parsedValue;
    out.raw = text;
    return true;
}

bool parseOptions(int argc, char** argv, Options& options, std::string& error) {
    for (int i = 1; i < argc; ++i) {
        const std::string flag = argv[i];
        auto needValue = [&](std::string& target) {
            if (i + 1 >= argc) {
                error = flag + " needs a value";
                return false;
            }
            target = argv[++i];
            return true;
        };
        if (flag == "--selftest") {
            options.selfTest = true;
        } else if (flag == "--list") {
            options.list = true;
            if (!needValue(options.pluginPath)) return false;
        } else if (flag == "--load" || flag == "--plugin") {
            if (!needValue(options.pluginPath)) return false;
        } else if (flag == "--name" || flag == "--plugin-name") {
            if (!needValue(options.name)) return false;
        } else if (flag == "--class-id") {
            if (!needValue(options.classId)) return false;
        } else if (flag == "--state-in") {
            if (!needValue(options.stateIn)) return false;
        } else if (flag == "--state-out") {
            if (!needValue(options.stateOut)) return false;
        } else if (flag == "--set-param") {
            std::string value;
            if (!needValue(value)) return false;
            SetParamArg arg;
            if (!parseSetParamArg(value, arg, error)) return false;
            options.setParams.push_back(arg);
        } else if (flag == "--host-name") {
            if (!needValue(options.hostName)) return false;
        } else if (flag == "--iid-log") {
            options.iidLog = true;
        } else if (flag == "--state-before-activate") {
            options.stateBeforeActivate = true;
        } else if (flag == "--rate" || flag == "--sample-rate") {
            std::string value;
            if (!needValue(value) || !parseDouble(value.c_str(), options.sampleRate)) {
                error = "--rate needs a sample rate in Hz";
                return false;
            }
        } else if (flag == "--block" || flag == "--block-size") {
            std::string value;
            if (!needValue(value) || !parseInt(value.c_str(), options.blockSize)) {
                error = "--block needs a block size in samples";
                return false;
            }
        } else if (flag == "--channels") {
            std::string value;
            if (!needValue(value) || !parseInt(value.c_str(), options.channels)) {
                error = "--channels needs a channel count";
                return false;
            }
        } else if (flag == "--process-seconds") {
            std::string value;
            if (!needValue(value) || !parseDouble(value.c_str(), options.processSeconds)) {
                error = "--process-seconds needs a duration";
                return false;
            }
        } else if (flag == "--editor-seconds") {
            std::string value;
            if (!needValue(value) || !parseDouble(value.c_str(), options.editorSeconds)) {
                error = "--editor-seconds needs a duration";
                return false;
            }
        } else {
            error = "unknown argument: " + flag;
            return false;
        }
    }
    // --selftest is the one mode that needs no plugin: it only exercises the state codec.
    if (options.pluginPath.empty() && !options.selfTest) {
        error = "give --list <path>, --load <path>, or --selftest";
        return false;
    }
    if (options.blockSize <= 0 || options.blockSize > 65536) {
        error = "--block must be between 1 and 65536";
        return false;
    }
    if (options.sampleRate <= 0.0) {
        error = "--rate must be positive";
        return false;
    }
    if (options.channels <= 0 || options.channels > 8) {
        error = "--channels must be between 1 and 8";
        return false;
    }
    return true;
}

std::string renderPluginInfo(const PluginInfo& info) {
    return jsonObject({
        jsonMember("name", jsonString(info.name)),
        jsonMember("vendor", jsonString(info.vendor)),
        jsonMember("version", jsonString(info.version)),
        jsonMember("category", jsonString(info.category)),
        jsonMember("identifier", jsonString(info.identifier)),
        jsonMember("format", jsonString(info.format)),
    });
}

bool readFileBytes(const std::string& path, std::vector<std::uint8_t>& out, std::string& error) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        error = "cannot open " + path;
        return false;
    }
    out.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    return true;
}

bool writeFileBytes(const std::string& path, const std::vector<std::uint8_t>& bytes,
                    std::string& error) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file) {
        error = "cannot write " + path;
        return false;
    }
    if (!bytes.empty()) {
        file.write(reinterpret_cast<const char*>(bytes.data()),
                   static_cast<std::streamsize>(bytes.size()));
    }
    return file.good();
}

// A deterministic noise source: the same input every run, so two probe runs of the same plugin
// are comparable.
class Noise {
public:
    float next() {
        state_ ^= state_ << 13;
        state_ ^= state_ >> 7;
        state_ ^= state_ << 17;
        const std::uint32_t bits = static_cast<std::uint32_t>(state_ >> 40);
        return (static_cast<float>(bits) / 8388608.0f - 1.0f) * 0.25f;
    }

private:
    std::uint64_t state_ = 0x9E3779B97F4A7C15ull;
};

struct ProcessReport {
    long long blocks = 0;
    long long nonFinite = 0;
    double rms = 0.0;
    double peak = 0.0;
    double avgMs = 0.0;
    double p99Ms = 0.0;
    double maxMs = 0.0;
    double budgetMs = 0.0;
    long long xruns = 0;
};

// Runs the process loop on its own thread, exactly like the live host will: the plugin's
// callbacks then really do arrive off the message thread and have to be marshalled.
ProcessReport runProcessTest(IPluginInstance& plugin, const Options& options,
                             const PrepareResult& prepared, double seconds) {
    ProcessReport report;
    const int frames = options.blockSize;
    const int channelsIn = std::max(0, prepared.channelsIn);
    const int channelsOut = std::max(1, prepared.channelsOut);

    std::vector<std::vector<float>> inputStorage(static_cast<std::size_t>(channelsIn),
                                                 std::vector<float>(static_cast<std::size_t>(frames), 0.0f));
    std::vector<std::vector<float>> outputStorage(static_cast<std::size_t>(channelsOut),
                                                  std::vector<float>(static_cast<std::size_t>(frames), 0.0f));
    std::vector<const float*> inputPointers(static_cast<std::size_t>(channelsIn), nullptr);
    std::vector<float*> outputPointers(static_cast<std::size_t>(channelsOut), nullptr);
    for (int ch = 0; ch < channelsIn; ++ch) inputPointers[static_cast<std::size_t>(ch)] = inputStorage[static_cast<std::size_t>(ch)].data();
    for (int ch = 0; ch < channelsOut; ++ch) outputPointers[static_cast<std::size_t>(ch)] = outputStorage[static_cast<std::size_t>(ch)].data();

    const long long totalBlocks = static_cast<long long>(
        std::max(1.0, std::ceil(seconds * options.sampleRate / static_cast<double>(frames))));
    report.budgetMs = 1000.0 * static_cast<double>(frames) / options.sampleRate;

    std::vector<double> timings;
    timings.reserve(static_cast<std::size_t>(totalBlocks));
    Noise noise;
    double sumSquares = 0.0;
    long long sampleCount = 0;
    std::atomic<bool> finished{false};

    std::thread audioThread([&] {
        // Ask for the audio scheduling class the live host uses. Best effort: a probe that
        // cannot get it still produces useful numbers, just noisier ones.
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

        TransportInfo transport;
        transport.playing = true;
        transport.tempoBpm = 120.0;
        transport.positionSamples = 0.0;

        for (long long block = 0; block < totalBlocks; ++block) {
            transport.discontinuity = block == 0;
            if (transport.discontinuity) plugin.resetDsp();

            for (int ch = 0; ch < channelsIn; ++ch) {
                float* data = inputStorage[static_cast<std::size_t>(ch)].data();
                for (int i = 0; i < frames; ++i) data[i] = noise.next();
            }

            const auto started = std::chrono::steady_clock::now();
            plugin.process(channelsIn > 0 ? inputPointers.data() : nullptr, outputPointers.data(),
                           frames, transport);
            const auto ended = std::chrono::steady_clock::now();
            timings.push_back(std::chrono::duration<double, std::milli>(ended - started).count());

            for (int ch = 0; ch < channelsOut; ++ch) {
                const float* data = outputStorage[static_cast<std::size_t>(ch)].data();
                for (int i = 0; i < frames; ++i) {
                    const float value = data[i];
                    if (!std::isfinite(value)) {
                        ++report.nonFinite;
                        continue;
                    }
                    sumSquares += static_cast<double>(value) * static_cast<double>(value);
                    const double magnitude = std::fabs(static_cast<double>(value));
                    if (magnitude > report.peak) report.peak = magnitude;
                    ++sampleCount;
                }
            }
            transport.positionSamples += frames;
        }
        finished.store(true, std::memory_order_release);
    });

    // The message thread keeps pumping while audio runs: restart flags, parameter edits from the
    // plugin and our own hops all land here.
    while (!finished.load(std::memory_order_acquire)) {
        pumpMessages();
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    audioThread.join();
    pumpMessages();

    report.blocks = totalBlocks;
    report.rms = sampleCount > 0 ? std::sqrt(sumSquares / static_cast<double>(sampleCount)) : 0.0;
    if (!timings.empty()) {
        double total = 0.0;
        for (double t : timings) {
            total += t;
            if (t > report.maxMs) report.maxMs = t;
            if (t > report.budgetMs) ++report.xruns;
        }
        report.avgMs = total / static_cast<double>(timings.size());
        std::vector<double> sorted = timings;
        std::sort(sorted.begin(), sorted.end());
        const std::size_t p99Index =
            std::min(sorted.size() - 1, static_cast<std::size_t>(sorted.size() * 99 / 100));
        report.p99Ms = sorted[p99Index];
    }
    return report;
}

int runList(const Options& options) {
    const PluginListing listing = listVst3Plugins(options.pluginPath);
    if (!listing.ok) {
        printErrorJson(listing.error);
        return listing.exitCodeHint != 0 ? listing.exitCodeHint : kExitLoadFailed;
    }
    std::vector<std::string> rendered;
    rendered.reserve(listing.plugins.size());
    for (const PluginInfo& info : listing.plugins) rendered.push_back(renderPluginInfo(info));
    std::printf("%s\n", jsonObject({
                            jsonMember("ok", jsonBool(true)),
                            jsonMember("path", jsonString(options.pluginPath)),
                            jsonMember("count", jsonInt(static_cast<long long>(rendered.size()))),
                            jsonMember("plugins", jsonArray(rendered)),
                        })
                            .c_str());
    std::fflush(stdout);
    return kExitOk;
}

int runLoad(const Options& options) {
    ProbeEvents events;
    const auto loadStarted = std::chrono::steady_clock::now();
    PluginLoadResult loaded =
        createVst3Plugin(options.pluginPath, options.name, options.classId, &events);
    const double loadSeconds =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - loadStarted).count();

    if (!loaded.plugin) {
        printErrorJson(loaded.error);
        return loaded.exitCodeHint != 0 ? loaded.exitCodeHint : kExitLoadFailed;
    }
    IPluginInstance& plugin = *loaded.plugin;

    // Hypothesis (ii) of the state-interchange investigation: does a plugin serialise different
    // bytes before setupProcessing/setActive than after? Capture here when asked, and skip the
    // usual post-prepare capture below.
    std::string preActivateState;
    bool capturedBeforeActivate = false;
    if (options.stateBeforeActivate && !options.stateOut.empty()) {
        std::vector<std::uint8_t> blob;
        std::string error;
        const bool captured = plugin.getState(blob, error);
        bool written = false;
        if (captured) written = writeFileBytes(options.stateOut, blob, error);
        capturedBeforeActivate = true;
        preActivateState = jsonMember(
            "state_out",
            jsonObject({jsonMember("path", jsonString(options.stateOut)),
                        jsonMember("when", jsonString("before-activate")),
                        jsonMember("bytes", jsonInt(static_cast<long long>(blob.size()))),
                        jsonMember("written", jsonBool(written)),
                        jsonMember("error", jsonString(written ? std::string() : error))}));
    }

    PrepareConfig config;
    config.sampleRate = options.sampleRate;
    config.maxBlockSize = options.blockSize;
    config.requestedChannels = options.channels;
    const PrepareResult prepared = plugin.prepare(config);
    if (!prepared.ok) {
        printErrorJson(prepared.error);
        return kExitBadLayout;
    }

    std::vector<std::string> members;
    members.push_back(jsonMember("ok", jsonBool(true)));
    members.push_back(jsonMember("path", jsonString(options.pluginPath)));
    members.push_back(jsonMember("plugin", renderPluginInfo(plugin.info())));
    members.push_back(jsonMember("load_seconds", jsonNumber(loadSeconds, 3)));
    members.push_back(jsonMember("sample_rate", jsonNumber(options.sampleRate, 1)));
    members.push_back(jsonMember("block_size", jsonInt(options.blockSize)));
    members.push_back(jsonMember("channels_requested", jsonInt(options.channels)));
    members.push_back(jsonMember("channels_in", jsonInt(prepared.channelsIn)));
    members.push_back(jsonMember("channels_out", jsonInt(prepared.channelsOut)));
    members.push_back(jsonMember("latency_samples", jsonInt(prepared.latencySamples)));
    members.push_back(jsonMember("tail_seconds", jsonNumber(prepared.tailSeconds, 3)));
    members.push_back(jsonMember("has_editor", jsonBool(plugin.hasEditor())));
    members.push_back(
        jsonMember("state_compat", jsonBool(plugin.stateIsPedalboardCompatible())));

    // --state-in before anything else: the run should reflect the restored state.
    if (!options.stateIn.empty()) {
        std::vector<std::uint8_t> blob;
        std::string error;
        bool applied = false;
        if (readFileBytes(options.stateIn, blob, error)) {
            applied = plugin.setState(blob.data(), blob.size(), error);
        }
        members.push_back(jsonMember(
            "state_in",
            jsonObject({jsonMember("path", jsonString(options.stateIn)),
                        jsonMember("bytes", jsonInt(static_cast<long long>(blob.size()))),
                        jsonMember("applied", jsonBool(applied)),
                        jsonMember("error", jsonString(applied ? std::string() : error))})));
    }

    // --set-param: applied after any --state-in restore (so it can override a restored preset)
    // and before the params dump and --state-out below, through the same controller + processor
    // path the live host uses. setParamNormalized() reaches the controller; a VST3 plugin only
    // reads a parameter change inside IAudioProcessor::process, so flushParameters() delivers the
    // same edit to the processor via a zero-sample call, matching what the engine does once audio
    // has stopped flowing.
    std::vector<std::string> appliedParams;
    for (const SetParamArg& arg : options.setParams) {
        const std::vector<ParamInfo> beforeParams = plugin.params();
        const ParamInfo* target = nullptr;
        // "index-or-id": a value that names a real parameter position wins; otherwise it is
        // looked up as a VST3 ParamID. Small plugins often number both the same way, so
        // resolution order is the only thing that makes the two schemes unambiguous.
        if (arg.id >= 0 && static_cast<std::size_t>(arg.id) < beforeParams.size()) {
            target = &beforeParams[static_cast<std::size_t>(arg.id)];
        } else {
            for (const ParamInfo& candidate : beforeParams) {
                if (candidate.id == static_cast<std::uint32_t>(arg.id)) {
                    target = &candidate;
                    break;
                }
            }
        }
        if (target == nullptr) {
            const std::string message = "--set-param: unknown parameter id/index: " + arg.raw;
            printErrorJson(message);
            std::fprintf(stderr, "%s\n", message.c_str());
            return kExitBadArgs;
        }
        const std::int32_t targetIndex = target->index;
        const std::uint32_t targetId = target->id;
        plugin.setParamNormalized(targetIndex, arg.value);
        plugin.flushParameters();
        const double readback = plugin.params()[static_cast<std::size_t>(targetIndex)].value;
        appliedParams.push_back(jsonObject({
            jsonMember("id", jsonInt(static_cast<long long>(targetId))),
            jsonMember("index", jsonInt(targetIndex)),
            jsonMember("requested", jsonNumber(arg.value)),
            jsonMember("readback", jsonNumber(readback)),
        }));
    }
    members.push_back(jsonMember("applied_params", jsonArray(appliedParams)));

    const std::vector<ParamInfo> parameters = plugin.params();
    members.push_back(jsonMember("param_count", jsonInt(static_cast<long long>(parameters.size()))));
    {
        std::vector<std::string> rendered;
        const std::size_t shown = std::min<std::size_t>(parameters.size(), 20);
        for (std::size_t i = 0; i < shown; ++i) {
            const ParamInfo& p = parameters[i];
            rendered.push_back(jsonObject({
                jsonMember("index", jsonInt(p.index)),
                jsonMember("id", jsonInt(static_cast<long long>(p.id))),
                jsonMember("name", jsonString(p.name)),
                jsonMember("label", jsonString(p.label)),
                jsonMember("default", jsonNumber(p.defaultValue)),
                jsonMember("value", jsonNumber(p.value)),
                jsonMember("steps", jsonInt(p.steps)),
                jsonMember("automatable", jsonBool(p.automatable)),
                jsonMember("discrete", jsonBool(p.discrete)),
                jsonMember("boolean", jsonBool(p.boolean_)),
            }));
        }
        members.push_back(jsonMember("params", jsonArray(rendered)));
    }

    if (options.processSeconds > 0.0) {
        const ProcessReport report = runProcessTest(plugin, options, prepared, options.processSeconds);
        members.push_back(jsonMember(
            "process",
            jsonObject({
                jsonMember("seconds", jsonNumber(options.processSeconds, 3)),
                jsonMember("blocks", jsonInt(report.blocks)),
                jsonMember("out_rms", jsonNumber(report.rms)),
                jsonMember("out_peak", jsonNumber(report.peak)),
                jsonMember("non_finite_samples", jsonInt(report.nonFinite)),
                jsonMember("block_ms_avg", jsonNumber(report.avgMs, 4)),
                jsonMember("block_ms_p99", jsonNumber(report.p99Ms, 4)),
                jsonMember("block_ms_max", jsonNumber(report.maxMs, 4)),
                jsonMember("block_ms_budget", jsonNumber(report.budgetMs, 4)),
                jsonMember("xruns", jsonInt(report.xruns)),
            })));
    }

    if (capturedBeforeActivate) {
        members.push_back(preActivateState);
    } else if (!options.stateOut.empty()) {
        std::vector<std::uint8_t> blob;
        std::string error;
        const bool captured = plugin.getState(blob, error);
        bool written = false;
        if (captured) written = writeFileBytes(options.stateOut, blob, error);
        members.push_back(jsonMember(
            "state_out",
            jsonObject({jsonMember("path", jsonString(options.stateOut)),
                        jsonMember("bytes", jsonInt(static_cast<long long>(blob.size()))),
                        jsonMember("written", jsonBool(written)),
                        jsonMember("error", jsonString(written ? std::string() : error))})));
    }

    if (options.editorSeconds > 0.0) {
        std::string error;
        const bool opened = plugin.openEditor(0, 0, 0, 0, 0, plugin.info().name, error);
        if (opened) pumpFor(options.editorSeconds);
        const std::vector<std::pair<std::int32_t, std::int32_t>> sizes = events.sizeEvents();
        std::vector<std::string> renderedSizes;
        for (const auto& size : sizes) {
            renderedSizes.push_back(jsonObject(
                {jsonMember("w", jsonInt(size.first)), jsonMember("h", jsonInt(size.second))}));
        }
        plugin.closeEditor();
        pumpMessages();
        members.push_back(jsonMember(
            "editor",
            jsonObject({jsonMember("opened", jsonBool(opened)),
                        jsonMember("seconds", jsonNumber(options.editorSeconds, 2)),
                        jsonMember("size_events", jsonArray(renderedSizes)),
                        jsonMember("closed_by_user", jsonBool(events.editorClosed())),
                        jsonMember("error", jsonString(opened ? std::string() : error))})));
    }

    {
        std::vector<std::string> warnings;
        for (const std::string& warning : loaded.warnings) warnings.push_back(jsonString(warning));
        for (const std::string& warning : prepared.warnings) warnings.push_back(jsonString(warning));
        for (const std::string& warning : events.warnings()) warnings.push_back(jsonString(warning));
        members.push_back(jsonMember("warnings", jsonArray(warnings)));
    }
    {
        std::vector<std::string> latencies;
        for (std::int32_t value : events.latencyChanges()) latencies.push_back(jsonInt(value));
        members.push_back(jsonMember("latency_changes", jsonArray(latencies)));
    }
    members.push_back(jsonMember("restarts_required", jsonInt(events.restartsRequired())));
    members.push_back(jsonMember("host_name", jsonString(options.hostName)));
    if (options.iidLog) {
        std::vector<std::string> queries;
        for (const Vst3IidQuery& query : vst3IidQueries()) {
            queries.push_back(jsonObject({
                jsonMember("site", jsonString(query.site)),
                jsonMember("iid", jsonString(query.iid)),
                jsonMember("name", jsonString(query.name)),
                jsonMember("answered", jsonBool(query.answered)),
                jsonMember("count", jsonInt(query.count)),
            }));
        }
        members.push_back(jsonMember("iid_queries", jsonArray(queries)));
    }
    members.push_back(jsonMember("param_edits_seen", jsonInt(events.paramEdits())));

    std::printf("%s\n", jsonObject(members).c_str());
    std::fflush(stdout);

    plugin.release();
    loaded.plugin.reset();
    pumpMessages();
    return kExitOk;
}

}  // namespace

int main(int argc, char** argv) {
    Options options;
    std::string error;
    if (!parseOptions(argc, argv, options, error)) {
        printErrorJson(error);
        std::fprintf(stderr, "%s\n", error.c_str());
        return kExitBadArgs;
    }

    if (options.selfTest) {
        std::string codecError;
        const bool ok = thedaw::vst3::selfTestStateCodec(codecError);
        std::printf("%s\n", jsonObject({jsonMember("ok", jsonBool(ok)),
                                        jsonMember("selftest", jsonString("state_codec")),
                                        jsonMember("error", jsonString(codecError))})
                                .c_str());
        std::fflush(stdout);
        return ok ? kExitOk : kExitBadArgs;
    }

    // Both are process-wide and must be in force before a plugin exists.
    if (!options.hostName.empty()) setVst3HostName(options.hostName);
    if (options.iidLog) setVst3IidLogging(true);

    // Per-monitor v2 before any window exists, so every rect the editor deals in is physical px.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    // Apartment-threaded: plugin editors are Win32 UI and expect STA.
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    if (!startMessageThread()) {
        printErrorJson("could not create the probe's message window");
        if (SUCCEEDED(comResult)) CoUninitialize();
        return kExitBadArgs;
    }

    int exitCode = kExitOk;
    if (options.list) {
        exitCode = runList(options);
    } else {
        exitCode = runLoad(options);
    }

    stopMessageThread();
    if (SUCCEEDED(comResult)) CoUninitialize();
    return exitCode;
}
