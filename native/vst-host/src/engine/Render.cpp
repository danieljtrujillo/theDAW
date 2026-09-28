#include "Render.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "../plugin/IPluginInstance.h"
#include "../util/AtomicFile.h"
#include "../util/Json.h"
#include "../util/Log.h"
#include "../util/SehGuard.h"
#include "../util/StringUtil.h"
#include "../util/Wav.h"
#include "ChannelMap.h"
#include "MessageLoop.h"
#include "MidiQueue.h"

namespace thedaw {
namespace {

constexpr int kExitOk = 0;
constexpr int kExitWriteFailed = 1;
constexpr int kExitPluginMissing = 3;
constexpr int kExitPluginFailed = 4;
constexpr int kExitBadLayout = 5;
constexpr int kExitUnreadableInput = 7;

// Mirrors Wav.cpp:18's kMaxDataBytes: the largest data payload a WAV RIFF chunk can declare.
// Checked against the render's own output size before that buffer is allocated, so an
// impossible render is refused in milliseconds instead of discovered after writeWavFile runs.
constexpr std::uint64_t kMaxRenderOutputBytes = 0xFFFF0000ull;

// A render is not realtime, but a plugin that has gone into an infinite loop must not hang a
// backend request forever; the loop below gives up after this much wall clock.
constexpr double kRenderWallClockLimitSeconds = 3600.0;

void printLine(const std::string& text) {
    std::fputs(text.c_str(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void printFailure(const std::string& message) {
    json::Writer writer;
    writer.beginObject()
        .boolField("ok", false)
        .strField("ev", "error")
        .strField("text", message)
        .boolField("fatal", true)
        .endObject();
    printLine(writer.text());
    std::fputs((message + "\n").c_str(), stderr);
    std::fflush(stderr);
}

// Collects what the plugin says while a render runs. Only the message thread touches it before
// the worker starts and after it joins; during the render the worker never reads it.
class RenderEvents final : public IPluginEvents {
public:
    void onLatencyChanged(int32_t latencySamples) override {
        latencyChanges_.push_back(latencySamples);
    }
    void onParamEdited(int32_t, double) override {}
    void onParamGesture(int32_t, bool) override {}
    void onEditorResized(int32_t, int32_t) override {}
    void onEditorClosed() override {}
    void onWarning(const std::string& text) override { warnings_.push_back(text); }
    void onRestartRequired() override { ++restartsRequired_; }

    const std::vector<int32_t>& latencyChanges() const { return latencyChanges_; }
    const std::vector<std::string>& warnings() const { return warnings_; }
    int restartsRequired() const { return restartsRequired_; }

private:
    std::vector<int32_t> latencyChanges_;
    std::vector<std::string> warnings_;
    int restartsRequired_ = 0;
};

bool readTextFile(const std::wstring& path, std::string& out, std::string& error) {
    std::vector<uint8_t> bytes;
    if (!util::readFile(path, bytes, error)) return false;
    out.assign(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    return true;
}

// `--params-json` is inline JSON when it opens a document, otherwise a file path. Nothing else
// can start with '{' or '[' on Windows, so the two cases never collide.
bool loadParamsDocument(const std::wstring& raw, std::string& text, std::string& error) {
    const std::string trimmed = util::trim(util::wideToUtf8(raw));
    if (!trimmed.empty() && (trimmed.front() == '{' || trimmed.front() == '[')) {
        text = trimmed;
        return true;
    }
    return readTextFile(raw, text, error);
}

int32_t findParamIndex(const std::vector<ParamInfo>& params, const std::string& key) {
    long long asIndex = 0;
    if (util::parseInt(key, asIndex)) {
        if (asIndex >= 0 && asIndex < static_cast<long long>(params.size())) {
            return static_cast<int32_t>(asIndex);
        }
        return -1;
    }
    for (const ParamInfo& param : params) {
        if (util::iequals(param.name, key)) return param.index;
    }
    return -1;
}

// Applies one {key -> normalized value} pair, collecting anything it could not honour.
void applyOneParam(IPluginInstance& plugin, const std::vector<ParamInfo>& params,
                   const std::string& key, const json::Value& value,
                   std::vector<std::string>& warnings, int& applied) {
    if (!value.isNumber()) {
        warnings.push_back("parameter \"" + key + "\" was not a number; it was not applied");
        return;
    }
    const int32_t index = findParamIndex(params, key);
    if (index < 0) {
        warnings.push_back("this plugin has no parameter \"" + key + "\"; it was not applied");
        return;
    }
    double normalized = value.number;
    if (!std::isfinite(normalized)) {
        warnings.push_back("parameter \"" + key + "\" was not a finite number; it was not applied");
        return;
    }
    if (normalized < 0.0 || normalized > 1.0) {
        warnings.push_back("parameter \"" + key + "\" was " + json::formatNumber(normalized) +
                           "; normalized values run 0..1, so it was clamped");
        normalized = std::clamp(normalized, 0.0, 1.0);
    }
    plugin.setParamNormalized(index, normalized);
    ++applied;
}

int applyParams(IPluginInstance& plugin, const std::wstring& rawArgument,
                std::vector<std::string>& warnings) {
    std::string text;
    std::string error;
    if (!loadParamsDocument(rawArgument, text, error)) {
        warnings.push_back("--params-json could not be read (" + error + "); no parameters applied");
        return 0;
    }
    json::Value document;
    if (!json::parse(text, document, error)) {
        warnings.push_back("--params-json is not valid JSON (" + error + "); no parameters applied");
        return 0;
    }

    const std::vector<ParamInfo> params = plugin.params();
    int applied = 0;
    if (document.isObject()) {
        for (const std::pair<std::string, json::Value>& entry : document.object) {
            applyOneParam(plugin, params, entry.first, entry.second, warnings, applied);
        }
        return applied;
    }
    if (document.isArray()) {
        for (const json::Value& entry : document.array) {
            if (!entry.isObject()) {
                warnings.push_back("--params-json array entries must be objects; one was skipped");
                continue;
            }
            const json::Value* value = entry.find("value");
            const json::Value* name = entry.find("name");
            const json::Value* index = entry.find("index");
            std::string key;
            if (name != nullptr && name->isString()) {
                key = name->str;
            } else if (index != nullptr && index->isNumber()) {
                key = util::toString(static_cast<long long>(index->number));
            } else {
                warnings.push_back("--params-json entry has neither \"index\" nor \"name\"");
                continue;
            }
            if (value == nullptr) {
                warnings.push_back("--params-json entry for \"" + key + "\" has no \"value\"");
                continue;
            }
            applyOneParam(plugin, params, key, *value, warnings, applied);
        }
        return applied;
    }
    warnings.push_back("--params-json must be a JSON object or array; no parameters applied");
    return 0;
}

double resolveTailSeconds(double requested, double reportedTailSeconds,
                          std::string& tailSource) {
    if (requested >= 0.0) {
        tailSource = "explicit";
        return requested;
    }
    if (reportedTailSeconds < 0.0) {
        // The plugin says its tail never ends. Something has to be finite, so cap it and say so.
        tailSource = "infinite-capped";
        return kRenderInfiniteTailSeconds;
    }
    if (reportedTailSeconds > kRenderTailCapSeconds) {
        tailSource = "capped";
        return kRenderTailCapSeconds;
    }
    tailSource = "plugin";
    return reportedTailSeconds;
}

// One message of --midi-events, at its sample frame of the render.
struct TimedMidi {
    int64_t frame = 0;
    MidiEvent event;
};

// Reads --midi-events: "<frame> <status> <data1> [<data2>]" per line, blank lines and lines
// starting with '#' skipped. A line that is not a channel voice message is counted in `skipped`
// rather than guessed at. The result is in frame order, lines at one frame in file order.
bool loadMidiEvents(const std::wstring& path, std::vector<TimedMidi>& out, size_t& skipped,
                    std::string& error) {
    std::vector<uint8_t> bytes;
    if (!util::readFile(path, bytes, error)) return false;
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    size_t start = 0;
    while (start <= text.size()) {
        size_t end = text.find('\n', start);
        if (end == std::string::npos) end = text.size();
        const std::string line = util::trim(text.substr(start, end - start));
        start = end + 1;
        if (line.empty() || line.front() == '#') continue;
        long long fields[4] = {0, 0, 0, 0};
        int count = 0;
        size_t cursor = 0;
        bool ok = true;
        while (cursor < line.size() && ok) {
            while (cursor < line.size() && (line[cursor] == ' ' || line[cursor] == '\t')) ++cursor;
            if (cursor >= line.size()) break;
            size_t stop = cursor;
            while (stop < line.size() && line[stop] != ' ' && line[stop] != '\t') ++stop;
            if (count >= 4 || !util::parseInt(line.substr(cursor, stop - cursor), fields[count])) {
                ok = false;
                break;
            }
            ++count;
            cursor = stop;
        }
        if (!ok || count < 3 || fields[0] < 0) {
            ++skipped;
            continue;
        }
        uint8_t data[3] = {0, 0, 0};
        const int size = count - 1;
        for (int i = 0; i < size; ++i) {
            if (fields[i + 1] < 0 || fields[i + 1] > 255) {
                ok = false;
                break;
            }
            data[i] = static_cast<uint8_t>(fields[i + 1]);
        }
        if (!ok || !MidiQueue::valid(data, size)) {
            ++skipped;
            continue;
        }
        TimedMidi timed;
        timed.frame = fields[0];
        timed.event.size = static_cast<uint8_t>(size);
        for (int i = 0; i < size; ++i) timed.event.data[i] = data[i];
        out.push_back(timed);
        if (end == text.size()) break;
    }
    std::stable_sort(out.begin(), out.end(),
                     [](const TimedMidi& a, const TimedMidi& b) { return a.frame < b.frame; });
    return true;
}

// Everything the worker thread needs, and everything it hands back.
struct RenderJob {
    IPluginInstance* plugin = nullptr;
    const util::WavAudio* input = nullptr;
    int fileChannels = 0;
    int channelsIn = 0;
    int channelsOut = 0;
    int blockSize = 0;
    double sampleRate = 48000.0;
    int64_t latencySamples = 0;
    int64_t tailFrames = 0;
    int64_t outputFrames = 0;
    // --midi-events, in frame order; empty for an effect render.
    const std::vector<TimedMidi>* midi = nullptr;

    std::vector<std::vector<float>> output;  // planar, fileChannels x outputFrames
    int64_t blocksProcessed = 0;
    int64_t nonFinite = 0;
    double peak = 0.0;
    double seconds = 0.0;
    unsigned long faultCode = 0;
    bool timedOut = false;
};

void renderOnWorker(RenderJob& job) {
    const int frames = job.blockSize;
    const int64_t total = job.outputFrames + job.latencySamples;

    std::vector<std::vector<float>> wireIn(static_cast<size_t>(job.fileChannels),
                                           std::vector<float>(static_cast<size_t>(frames), 0.0f));
    std::vector<std::vector<float>> pluginIn(static_cast<size_t>(std::max(1, job.channelsIn)),
                                             std::vector<float>(static_cast<size_t>(frames), 0.0f));
    std::vector<std::vector<float>> pluginOut(static_cast<size_t>(job.channelsOut),
                                              std::vector<float>(static_cast<size_t>(frames), 0.0f));
    std::vector<std::vector<float>> wireOut(static_cast<size_t>(job.fileChannels),
                                            std::vector<float>(static_cast<size_t>(frames), 0.0f));

    std::vector<const float*> wireInPtr(wireIn.size());
    std::vector<float*> pluginInPtr(pluginIn.size());
    std::vector<const float*> pluginInConstPtr(pluginIn.size());
    std::vector<float*> pluginOutPtr(pluginOut.size());
    std::vector<const float*> pluginOutConstPtr(pluginOut.size());
    std::vector<float*> wireOutPtr(wireOut.size());
    for (size_t i = 0; i < wireIn.size(); ++i) wireInPtr[i] = wireIn[i].data();
    for (size_t i = 0; i < pluginIn.size(); ++i) {
        pluginInPtr[i] = pluginIn[i].data();
        pluginInConstPtr[i] = pluginIn[i].data();
    }
    for (size_t i = 0; i < pluginOut.size(); ++i) {
        pluginOutPtr[i] = pluginOut[i].data();
        pluginOutConstPtr[i] = pluginOut[i].data();
    }
    for (size_t i = 0; i < wireOut.size(); ++i) wireOutPtr[i] = wireOut[i].data();

    const int64_t inputFrames = static_cast<int64_t>(job.input->frames());
    TransportInfo transport;
    transport.playing = true;
    transport.tempoBpm = 0.0;  // a file has no tempo to declare; 0 means "unknown" on the wire too

    const auto started = std::chrono::steady_clock::now();
    IPluginInstance* plugin = job.plugin;
    // This block's MIDI, at offsets inside it. Not the realtime thread: it may grow.
    std::vector<MidiEvent> blockMidi;
    size_t nextMidi = 0;

    int64_t fed = 0;
    while (fed < total) {
        const int64_t remaining = total - fed;
        const int chunk = static_cast<int>(std::min<int64_t>(frames, remaining));

        for (int ch = 0; ch < job.fileChannels; ++ch) {
            float* dst = wireIn[static_cast<size_t>(ch)].data();
            const std::vector<float>& src = job.input->samples[static_cast<size_t>(ch)];
            for (int i = 0; i < chunk; ++i) {
                const int64_t position = fed + i;
                // Past the end of the file the plugin is fed silence, which is what flushes its
                // latency out and lets its tail ring.
                dst[i] = position < inputFrames ? src[static_cast<size_t>(position)] : 0.0f;
            }
        }
        mapChannels(wireInPtr.data(), job.fileChannels, pluginInPtr.data(), job.channelsIn, chunk);

        transport.discontinuity = fed == 0;
        transport.positionSamples = static_cast<double>(fed);
        blockMidi.clear();
        if (job.midi != nullptr) {
            while (nextMidi < job.midi->size() && (*job.midi)[nextMidi].frame < fed + chunk) {
                MidiEvent ev = (*job.midi)[nextMidi].event;
                ev.sampleOffset = static_cast<int32_t>(std::max<int64_t>(0, (*job.midi)[nextMidi].frame - fed));
                blockMidi.push_back(ev);
                ++nextMidi;
            }
        }
        const unsigned long fault = util::guarded([&] {
            if (transport.discontinuity) plugin->resetDsp();
            plugin->setBlockMidi(blockMidi.empty() ? nullptr : blockMidi.data(),
                                 static_cast<int32_t>(blockMidi.size()));
            plugin->process(job.channelsIn > 0 ? pluginInConstPtr.data() : nullptr,
                            pluginOutPtr.data(), chunk, transport);
        });
        if (fault != 0) {
            job.faultCode = fault;
            break;
        }

        mapChannels(pluginOutConstPtr.data(), job.channelsOut, wireOutPtr.data(), job.fileChannels,
                    chunk);

        // Drop exactly `latencySamples` from the head: that is the plugin's own delay, and the
        // silence we appended at the tail is what replaces it.
        for (int i = 0; i < chunk; ++i) {
            const int64_t produced = fed + i;
            const int64_t target = produced - job.latencySamples;
            if (target < 0 || target >= job.outputFrames) continue;
            for (int ch = 0; ch < job.fileChannels; ++ch) {
                const float value = wireOut[static_cast<size_t>(ch)][static_cast<size_t>(i)];
                if (!std::isfinite(value)) {
                    ++job.nonFinite;
                    job.output[static_cast<size_t>(ch)][static_cast<size_t>(target)] = 0.0f;
                    continue;
                }
                job.output[static_cast<size_t>(ch)][static_cast<size_t>(target)] = value;
                const double magnitude = std::fabs(static_cast<double>(value));
                if (magnitude > job.peak) job.peak = magnitude;
            }
        }

        fed += chunk;
        ++job.blocksProcessed;

        if (std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count() >
            kRenderWallClockLimitSeconds) {
            job.timedOut = true;
            break;
        }
    }
    job.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
}

void renderDoneTrampoline(void* context) {
    MessageLoop* loop = static_cast<MessageLoop*>(context);
    if (loop != nullptr) loop->postQuit(0);
}

}  // namespace

int runRender(const Options& options, MessageLoop& loop) {
    const std::string inputPath = util::wideToUtf8(options.inputPath);
    const std::string outputPath = util::wideToUtf8(options.outputPath);

    util::WavAudio input;
    std::string error;
    if (!util::readWavFile(inputPath, input, error)) {
        printFailure(error);
        return kExitUnreadableInput;
    }

    if (!options.hostName.empty()) setVst3HostName(options.hostName);
    if (options.iidLog) setVst3IidLogging(true);

    std::vector<std::string> warnings;
    RenderEvents events;
    std::unique_ptr<IPluginInstance> plugin;
    double loadSeconds = 0.0;
    if (options.nullPlugin) {
        plugin = createNullPlugin(&events);
    } else {
        if (!util::fileExists(options.pluginPath)) {
            printFailure("plugin file not found: " + util::wideToUtf8(options.pluginPath));
            return kExitPluginMissing;
        }
        const auto loadStarted = std::chrono::steady_clock::now();
        PluginLoadResult loaded =
            createVst3Plugin(util::wideToUtf8(options.pluginPath), options.pluginName,
                             options.classId, &events);
        loadSeconds =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - loadStarted).count();
        warnings.insert(warnings.end(), loaded.warnings.begin(), loaded.warnings.end());
        if (loaded.plugin == nullptr) {
            printFailure(loaded.error.empty() ? "plugin failed to load" : loaded.error);
            return loaded.exitCodeHint != 0 ? loaded.exitCodeHint : kExitPluginFailed;
        }
        plugin = std::move(loaded.plugin);
    }

    PrepareConfig config;
    config.sampleRate = input.sampleRate;
    config.maxBlockSize = options.blockSize;
    config.requestedChannels = input.channels;
    config.offline = true;

    IPluginInstance* instance = plugin.get();
    PrepareResult prepared;
    const unsigned long prepareFault = util::guarded([&] { prepared = instance->prepare(config); });
    if (prepareFault != 0) {
        printFailure("the plugin crashed while being prepared for rendering");
        return kExitPluginFailed;
    }
    if (!prepared.ok) {
        printFailure(prepared.error.empty() ? "the plugin refused this audio setup"
                                            : prepared.error);
        return kExitBadLayout;
    }
    warnings.insert(warnings.end(), prepared.warnings.begin(), prepared.warnings.end());

    // State first, parameters second: --params-json is an override of whatever the state holds.
    if (!options.stateFile.empty()) {
        std::vector<uint8_t> blob;
        std::string stateError;
        if (!util::readFile(options.stateFile, blob, stateError)) {
            warnings.push_back("--state-file could not be read (" + stateError +
                               "); the plugin renders at its defaults");
        } else {
            bool applied = false;
            const unsigned long fault = util::guarded([&] {
                applied = instance->setState(blob.data(), blob.size(), stateError);
            });
            if (fault != 0) {
                warnings.push_back(
                    "the plugin crashed inside its own setState(); it renders at its defaults");
            } else if (!applied) {
                warnings.push_back("the plugin rejected the saved state (" + stateError +
                                   "); it renders at its defaults");
            }
        }
    }

    int paramsApplied = 0;
    if (!options.paramsJson.empty()) {
        paramsApplied = applyParams(*instance, options.paramsJson, warnings);
    }

    std::vector<TimedMidi> midi;
    if (!options.midiEvents.empty()) {
        size_t skipped = 0;
        std::string midiError;
        if (!loadMidiEvents(options.midiEvents, midi, skipped, midiError)) {
            printFailure("--midi-events could not be read: " + midiError);
            return kExitUnreadableInput;
        }
        if (skipped > 0) {
            warnings.push_back(util::toString(static_cast<long long>(skipped)) +
                               " line(s) of --midi-events were not channel voice messages and were skipped");
        }
    }

    std::string tailSource;
    const double tailSeconds =
        resolveTailSeconds(options.tailSeconds, prepared.tailSeconds, tailSource);

    RenderJob job;
    job.plugin = instance;
    job.input = &input;
    job.fileChannels = input.channels;
    job.channelsIn = std::max(0, prepared.channelsIn);
    job.channelsOut = std::max(1, prepared.channelsOut);
    job.blockSize = std::max(1, options.blockSize);
    job.sampleRate = input.sampleRate;
    job.latencySamples = std::max<int32_t>(0, prepared.latencySamples);
    job.tailFrames =
        static_cast<int64_t>(std::llround(tailSeconds * input.sampleRate));
    job.outputFrames = static_cast<int64_t>(input.frames()) + job.tailFrames;
    job.midi = midi.empty() ? nullptr : &midi;

    // A render whose output cannot fit in a WAV file must be refused now, before the output
    // buffer is allocated or the worker thread starts — writeWavFile enforces this same ceiling
    // (Wav.cpp:18's kMaxDataBytes) but only after the whole render has already run.
    if (job.outputFrames >= 0) {
        const std::uint64_t outputBytes = static_cast<std::uint64_t>(job.outputFrames) *
                                           static_cast<std::uint64_t>(job.fileChannels) * 4ull;
        if (outputBytes > kMaxRenderOutputBytes) {
            const unsigned long releaseFault = util::guarded([&] { instance->release(); });
            if (releaseFault != 0) {
                warnings.push_back("the plugin crashed while being shut down after the render");
            }
            printFailure(
                "this render would produce " +
                util::toString(static_cast<long long>(job.outputFrames)) +
                " frames across " + util::toString(static_cast<long long>(job.fileChannels)) +
                " channels, which is larger than a WAV file can hold; shorten the input or "
                "use a smaller --tail-seconds");
            return kExitWriteFailed;
        }
    }

    job.output.assign(static_cast<size_t>(job.fileChannels),
                      std::vector<float>(static_cast<size_t>(job.outputFrames), 0.0f));

    // The worker mirrors the live topology: process() off the message thread, so plugin
    // callbacks really do have to marshal, exactly as they do in a live session.
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (done == nullptr) {
        printFailure("could not create the render's completion event");
        return kExitWriteFailed;
    }
    if (!loop.addEvent(done, renderDoneTrampoline, &loop)) {
        CloseHandle(done);
        printFailure("could not attach the render to the message loop");
        return kExitWriteFailed;
    }

    std::thread worker([&job, done] {
        renderOnWorker(job);
        SetEvent(done);
    });
    loop.run();
    worker.join();
    CloseHandle(done);

    const PluginInfo pluginInfo = instance->info();
    const bool stateCompat = instance->stateIsPedalboardCompatible();
    const unsigned long releaseFault = util::guarded([&] { instance->release(); });
    if (releaseFault != 0) {
        warnings.push_back("the plugin crashed while being shut down after the render");
    }

    if (job.faultCode != 0) {
        printFailure("the plugin crashed while rendering (structured exception " +
                     util::toString(static_cast<long long>(job.faultCode)) + ")");
        return kExitPluginFailed;
    }
    if (job.timedOut) {
        printFailure("the render passed its wall-clock limit of " +
                     util::toString(static_cast<long long>(kRenderWallClockLimitSeconds)) +
                     " s and was abandoned");
        return kExitPluginFailed;
    }

    if (!util::writeWavFile(outputPath, job.output, input.sampleRate, error)) {
        printFailure("could not write " + outputPath + ": " + error);
        return kExitWriteFailed;
    }

    for (const std::string& warning : events.warnings()) warnings.push_back(warning);
    for (int32_t value : events.latencyChanges()) {
        // Plugins routinely re-announce the latency they already had (iZotope Vinyl does it on
        // every setup). Only a value that differs from the one the render aligned to matters.
        if (static_cast<int64_t>(value) == job.latencySamples) continue;
        warnings.push_back("the plugin changed its latency to " +
                           util::toString(static_cast<long long>(value)) +
                           " samples during the render; the output is aligned to the " +
                           util::toString(static_cast<long long>(job.latencySamples)) +
                           " samples it reported at setup");
    }

    json::Writer writer;
    writer.beginObject()
        .boolField("ok", true)
        .strField("mode", "render")
        .strField("plugin", pluginInfo.name)
        .strField("format", pluginInfo.format)
        .numField("load_seconds", loadSeconds)
        .strField("input", inputPath)
        .strField("input_format", input.sourceFormat)
        .strField("output", outputPath)
        .numField("sample_rate", input.sampleRate)
        .intField("channels", input.channels)
        .intField("channels_in", prepared.channelsIn)
        .intField("channels_out", prepared.channelsOut)
        .intField("block_size", job.blockSize)
        .intField("frames_in", static_cast<long long>(input.frames()))
        .intField("frames_out", job.outputFrames)
        .intField("latency_samples", job.latencySamples)
        .numField("tail_seconds", tailSeconds)
        .strField("tail_source", tailSource)
        .intField("tail_frames", job.tailFrames)
        .intField("blocks", job.blocksProcessed)
        .intField("params_applied", paramsApplied)
        .intField("midi_events", static_cast<long long>(midi.size()))
        .numField("peak", job.peak)
        .intField("non_finite_samples", job.nonFinite)
        .numField("render_seconds", job.seconds)
        .boolField("state_compat", stateCompat)
        .intField("restarts_required", events.restartsRequired());

    const double audioSeconds =
        input.sampleRate > 0 ? static_cast<double>(job.outputFrames) / input.sampleRate : 0.0;
    writer.numField("realtime_factor",
                    job.seconds > 0.0 ? audioSeconds / job.seconds : 0.0);

    writer.key("warnings").beginArray();
    for (const std::string& warning : warnings) writer.valueString(warning);
    writer.endArray();

    if (options.iidLog) {
        writer.key("iid_queries").beginArray();
        for (const Vst3IidQuery& query : vst3IidQueries()) {
            writer.beginObject()
                .strField("site", query.site)
                .strField("iid", query.iid)
                .strField("name", query.name)
                .boolField("answered", query.answered)
                .intField("count", query.count)
                .endObject();
        }
        writer.endArray();
    }
    writer.endObject();
    printLine(writer.text());
    return kExitOk;
}

}  // namespace thedaw
