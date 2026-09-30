// The passthrough "plugin" behind --null-plugin.
//
// It exists so the socket, framing, control plane, state and bypass paths can be
// tested end to end with no third-party binary in the loop. It reports two fake
// parameters that do not touch the audio, which is what makes the bit-exact
// round-trip assertions in tests/test_vst_host_native.py meaningful.
//
// MIDI makes it audible, so the `midi` op can be tested the same way: a note-on
// adds velocity / 127 to every output channel at the note's sample, and a
// note-off (a note-on at velocity 0 included) adds -0.25 there. A block with no
// MIDI stays a bit-exact passthrough.

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>

#include "../plugin/IPluginInstance.h"

namespace thedaw {
namespace {

constexpr int32_t kParamCount = 2;
const char kStateMagic[8] = {'T', 'D', 'N', 'U', 'L', 'L', 'S', 'T'};
constexpr uint32_t kStateVersion = 1;

struct NullParamSpec {
    const char* name;
    const char* label;
    double defaultValue;
};

const NullParamSpec kParamSpecs[kParamCount] = {
    {"Alpha", "", 0.5},
    {"Beta", "%", 0.25},
};

double clamp01(double value) {
    if (!(value >= 0.0)) return 0.0;  // also catches NaN
    if (value > 1.0) return 1.0;
    return value;
}

class NullPlugin final : public IPluginInstance {
public:
    explicit NullPlugin(IPluginEvents* events) : events_(events) {
        for (int32_t i = 0; i < kParamCount; ++i) {
            values_[i].store(kParamSpecs[i].defaultValue, std::memory_order_relaxed);
        }
    }

    PluginInfo info() const override {
        PluginInfo out;
        out.name = "Null Passthrough";
        out.vendor = "theDAW";
        out.version = "1.0.0";
        out.category = "Fx";
        out.identifier = "00000000000000000000000000000000";
        out.format = "null";
        return out;
    }

    bool hasEditor() const override { return false; }

    PrepareResult prepare(const PrepareConfig& config) override {
        config_ = config;
        PrepareResult result;
        const int32_t channels = std::clamp(config.requestedChannels, 1, 8);
        if (channels != config.requestedChannels) {
            result.warnings.push_back("null plugin clamped the channel count to " +
                                      std::to_string(channels));
        }
        result.ok = true;
        result.channelsIn = channels;
        result.channelsOut = channels;
        result.latencySamples = 0;
        result.tailSeconds = 0.0;
        return result;
    }

    PrepareResult reprepare() override { return prepare(config_); }

    void release() override {}

    std::vector<ParamInfo> params() override {
        std::vector<ParamInfo> out;
        out.reserve(kParamCount);
        for (int32_t i = 0; i < kParamCount; ++i) {
            ParamInfo info;
            info.index = i;
            info.id = static_cast<uint32_t>(i);
            info.name = kParamSpecs[i].name;
            info.label = kParamSpecs[i].label;
            info.defaultValue = kParamSpecs[i].defaultValue;
            info.value = values_[i].load(std::memory_order_relaxed);
            info.steps = 0;
            info.automatable = true;
            info.discrete = false;
            info.boolean_ = false;
            info.text = paramText(i, info.value);
            out.push_back(std::move(info));
        }
        return out;
    }

    void paramValues(std::vector<double>& out) override {
        out.resize(kParamCount);
        for (int32_t i = 0; i < kParamCount; ++i) out[static_cast<size_t>(i)] = values_[i].load(std::memory_order_relaxed);
    }

    std::string paramText(int32_t index, double normalizedValue) override {
        if (index < 0 || index >= kParamCount) return {};
        char buffer[32];
        std::snprintf(buffer, sizeof(buffer), "%.2f", normalizedValue);
        return buffer;
    }

    bool getState(std::vector<uint8_t>& out, std::string& error) override {
        (void)error;
        out.clear();
        out.reserve(sizeof(kStateMagic) + 8 + kParamCount * sizeof(double));
        out.insert(out.end(), kStateMagic, kStateMagic + sizeof(kStateMagic));
        appendU32(out, kStateVersion);
        appendU32(out, static_cast<uint32_t>(kParamCount));
        for (int32_t i = 0; i < kParamCount; ++i) {
            const double value = values_[i].load(std::memory_order_relaxed);
            uint8_t bytes[sizeof(double)];
            std::memcpy(bytes, &value, sizeof(bytes));
            out.insert(out.end(), bytes, bytes + sizeof(bytes));
        }
        return true;
    }

    bool setState(const uint8_t* data, size_t size, std::string& error) override {
        const size_t headerSize = sizeof(kStateMagic) + 8;
        if (data == nullptr || size < headerSize) {
            error = "null plugin state blob is too short";
            return false;
        }
        if (std::memcmp(data, kStateMagic, sizeof(kStateMagic)) != 0) {
            error = "null plugin state blob has the wrong magic";
            return false;
        }
        const uint32_t version = readU32(data + sizeof(kStateMagic));
        if (version != kStateVersion) {
            error = "null plugin state version " + std::to_string(version) +
                    " is not supported";
            return false;
        }
        const uint32_t count = readU32(data + sizeof(kStateMagic) + 4);
        if (count > static_cast<uint32_t>(kParamCount) ||
            size < headerSize + static_cast<size_t>(count) * sizeof(double)) {
            error = "null plugin state blob is truncated";
            return false;
        }
        for (uint32_t i = 0; i < count; ++i) {
            double value = 0;
            std::memcpy(&value, data + headerSize + i * sizeof(double), sizeof(value));
            values_[i].store(clamp01(value), std::memory_order_relaxed);
        }
        return true;
    }

    bool stateIsPedalboardCompatible() const override { return true; }

    bool openEditor(uint64_t parentHwnd, int x, int y, int w, int h,
                    const std::string& title, std::string& error) override {
        (void)parentHwnd;
        (void)x;
        (void)y;
        (void)w;
        (void)h;
        (void)title;
        error = "the null plugin has no editor";
        return false;
    }

    void setEditorRect(int x, int y, int w, int h) override {
        (void)x;
        (void)y;
        (void)w;
        (void)h;
    }

    void closeEditor() override {}
    bool editorOpen() const override { return false; }

    void setParamNormalized(int32_t index, double value) override {
        if (index < 0 || index >= kParamCount) return;
        values_[index].store(clamp01(value), std::memory_order_relaxed);
    }

    void process(const float* const* in, float* const* out, int32_t frames,
                 const TransportInfo& transport) override {
        (void)transport;
        const int32_t channels = std::clamp(config_.requestedChannels, 1, 8);
        for (int32_t ch = 0; ch < channels; ++ch) {
            if (in[ch] == out[ch]) continue;
            std::copy(in[ch], in[ch] + frames, out[ch]);
        }
        for (int32_t i = 0; i < midiCount_; ++i) {
            const MidiEvent& ev = midi_[i];
            if (ev.sampleOffset < 0 || ev.sampleOffset >= frames || ev.size < 3) continue;
            const uint8_t kind = ev.data[0] & 0xF0;
            float mark = 0.0f;
            if (kind == 0x90 && ev.data[2] > 0) {
                mark = static_cast<float>(ev.data[2]) / 127.0f;
            } else if (kind == 0x80 || kind == 0x90) {
                mark = -0.25f;
            }
            if (mark == 0.0f) continue;
            for (int32_t ch = 0; ch < channels; ++ch) out[ch][ev.sampleOffset] += mark;
        }
        midiCount_ = 0;
    }

    void setBlockMidi(const MidiEvent* events, int32_t count) override {
        midi_ = events;
        midiCount_ = events != nullptr ? count : 0;
    }

    // setParamNormalized() already stored the value where params() reads it, so there is
    // nothing queued for a zero-sample call to carry. Kept so the engine can flush any plugin.
    void flushParameters() override {}

    void resetDsp() override {}

private:
    static void appendU32(std::vector<uint8_t>& out, uint32_t value) {
        out.push_back(static_cast<uint8_t>(value & 0xFFu));
        out.push_back(static_cast<uint8_t>((value >> 8) & 0xFFu));
        out.push_back(static_cast<uint8_t>((value >> 16) & 0xFFu));
        out.push_back(static_cast<uint8_t>((value >> 24) & 0xFFu));
    }

    static uint32_t readU32(const uint8_t* data) {
        return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
               (static_cast<uint32_t>(data[2]) << 16) |
               (static_cast<uint32_t>(data[3]) << 24);
    }

    IPluginEvents* events_ = nullptr;
    PrepareConfig config_;
    const MidiEvent* midi_ = nullptr;
    int32_t midiCount_ = 0;
    std::atomic<double> values_[kParamCount];
};

}  // namespace

std::unique_ptr<IPluginInstance> createNullPlugin(IPluginEvents* events) {
    return std::make_unique<NullPlugin>(events);
}

}  // namespace thedaw
