// theDAW live VST host — the seam between the session engine (socket, audio thread, control
// plane) and a plugin implementation (the VST3 hosting layer, or the null passthrough used by tests).
//
// Contract file: owned by the batch lead. The engine (src/engine, src/net) codes against this
// interface; src/vst3 implements it. Neither side changes this file on its own.
//
// Threading words used below:
//   MESSAGE thread = the process main thread running the Win32 message loop.
//   AUDIO thread   = the realtime thread that calls process(); it never allocates, never takes a
//                    blocking lock, never logs.
//   "audio parked" = the engine has stopped calling process() and waits until told to resume.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace thedaw {

struct PluginInfo {
    std::string name;
    std::string vendor;
    std::string version;
    std::string category;    // VST3 subCategories string, e.g. "Fx|Mastering"
    std::string identifier;  // 32 hex chars: the VST3 class id
    std::string format;      // "VST3" (or "null")
};

struct ParamInfo {
    int32_t index = 0;       // position in the plugin's parameter list (what the wire protocol uses)
    uint32_t id = 0;         // VST3 ParamID
    std::string name;
    std::string label;       // units
    double defaultValue = 0; // normalized 0..1
    double value = 0;        // normalized 0..1
    int32_t steps = 0;       // 0 = continuous
    bool automatable = true;
    bool discrete = false;
    bool boolean_ = false;
    // The list holds EVERY parameter the plugin's controller declares, in the controller's own
    // order (what JUCE's VST3 host does), so `index` is the index any other host would use.
    // What a parameter is for is said by these flags; a UI hides `hidden` ones, it does not
    // get a shorter list.
    bool hidden = false;         // the plugin's own book-keeping (kIsHidden)
    bool readOnly = false;       // a meter or a display value (kIsReadOnly)
    bool isBypass = false;       // the plugin's own bypass switch (kIsBypass)
    bool isProgramChange = false;  // selects a program of the plugin's program list
    std::string text;            // the plugin's words for `value`, e.g. "-6.0 dB"; may be empty
};

struct TransportInfo {
    bool playing = false;
    bool discontinuity = false;  // start / seek / loop wrap: the block does not follow the last one
    double positionSamples = 0;  // project timeline position of the first frame
    double tempoBpm = 0;         // 0 = unknown
};

// One MIDI channel voice message inside a process() block (docs/design/vst-live-protocol.md,
// the `midi` op). The engine places each message the client sent by its timeline position.
struct MidiEvent {
    int32_t sampleOffset = 0;      // 0 .. frames - 1 of the block it rides
    uint8_t data[3] = {0, 0, 0};   // status byte, then its data bytes
    uint8_t size = 0;              // 1..3
};

struct PrepareConfig {
    double sampleRate = 48000;
    int32_t maxBlockSize = 512;
    int32_t requestedChannels = 2;
    // Offline (faster-than-realtime) rendering. The plugin is set up with kOffline instead of
    // kRealtime, which is what lets a lookahead/oversampling plugin do its full-quality job.
    // The live session always leaves this false.
    bool offline = false;
};

struct PrepareResult {
    bool ok = false;
    std::string error;           // set when !ok
    int32_t channelsIn = 0;      // what process() expects from the engine
    int32_t channelsOut = 0;     // what process() writes
    int32_t latencySamples = 0;
    double tailSeconds = 0;      // < 0 = infinite
    std::vector<std::string> warnings;
};

// Callbacks from the plugin side to the engine. All are invoked on the MESSAGE thread.
class IPluginEvents {
public:
    virtual ~IPluginEvents() = default;
    virtual void onLatencyChanged(int32_t latencySamples) = 0;
    virtual void onParamEdited(int32_t index, double normalizedValue) = 0;  // user moved a control in the editor
    // The user grabbed (begin = true) or let go of (begin = false) a control in the editor. Every
    // onParamEdited for that parameter in between belongs to ONE gesture.
    virtual void onParamGesture(int32_t index, bool begin) = 0;
    virtual void onEditorResized(int32_t width, int32_t height) = 0;        // physical px
    virtual void onEditorClosed() = 0;                                      // floating window closed by the user
    virtual void onWarning(const std::string& text) = 0;
    // The plugin asked for something that needs the audio thread parked (bus/latency/reload).
    // The engine parks audio, calls reprepare() on the MESSAGE thread, then resumes.
    virtual void onRestartRequired() = 0;
};

class IPluginInstance {
public:
    virtual ~IPluginInstance() = default;

    // ---- MESSAGE thread ----
    virtual PluginInfo info() const = 0;
    virtual bool hasEditor() const = 0;
    // Set up buses and processing. Audio must be parked (or not started yet).
    virtual PrepareResult prepare(const PrepareConfig& config) = 0;
    // Re-run setup after onRestartRequired(); same rules as prepare(), same config.
    virtual PrepareResult reprepare() = 0;
    virtual void release() = 0;  // stop processing, deactivate; audio parked
    virtual std::vector<ParamInfo> params() = 0;
    // Just the current normalized values, in params() order, without names or display strings:
    // cheap enough to call after every edit on a plugin with thousands of parameters.
    virtual void paramValues(std::vector<double>& out) = 0;
    // The plugin's own display string for `normalizedValue` of parameter `index` (what a generic
    // parameter UI shows while a slider moves). Empty when the plugin has nothing to say.
    virtual std::string paramText(int32_t index, double normalizedValue) = 0;
    // Full state (component + controller) in the container format pedalboard's `raw_state` uses.
    // Audio must be parked for both.
    virtual bool getState(std::vector<uint8_t>& out, std::string& error) = 0;
    virtual bool setState(const uint8_t* data, size_t size, std::string& error) = 0;
    // True when getState()/setState() speak the pedalboard-compatible container for this plugin.
    virtual bool stateIsPedalboardCompatible() const = 0;
    // parentHwnd == 0 → floating top-level window titled `title`. Otherwise a borderless window
    // owned by parentHwnd, placed at (x, y, w, h) in physical screen px.
    virtual bool openEditor(uint64_t parentHwnd, int x, int y, int w, int h,
                            const std::string& title, std::string& error) = 0;
    virtual void setEditorRect(int x, int y, int w, int h) = 0;
    virtual void closeEditor() = 0;
    virtual bool editorOpen() const = 0;

    // ---- any thread (lock-free handoff to the AUDIO thread) ----
    virtual void setParamNormalized(int32_t index, double value) = 0;

    // ---- AUDIO thread only ----
    // `in` has channelsIn pointers, `out` has channelsOut pointers, each `frames` long
    // (frames <= maxBlockSize). in and out never alias. Must be realtime-safe.
    virtual void process(const float* const* in, float* const* out, int32_t frames,
                         const TransportInfo& transport) = 0;
    // Deliver parameter changes queued by setParamNormalized() when no audio is flowing.
    // VST3 hands parameter changes to a plugin inside IAudioProcessor::process, so a host that
    // has stopped calling process() has to make a call that carries nothing but the changes:
    // numSamples = 0, no buses, only inputParameterChanges set. Plugins whose controller mirrors
    // the processor (the iZotope ones do) report the OLD value until that call happens.
    // Realtime-safe like process(): no allocation, no locks, no logging. The engine calls this
    // on the AUDIO thread only, never concurrently with process(), never while audio is parked.
    virtual void flushParameters() = 0;
    // Clear delay lines / tails after a discontinuity. Realtime-safe.
    virtual void resetDsp() = 0;
    // The MIDI the NEXT process() call plays, sorted by sampleOffset; `events` stays valid until
    // that call returns. Called on the AUDIO thread right before every process(), with count 0
    // for a block that carries none. An instrument turns these into its note events and
    // controller parameters; an effect has nothing to play them on and ignores them, which is
    // what this default does. Realtime-safe like process().
    virtual void setBlockMidi(const MidiEvent* events, int32_t count) {
        (void)events;
        (void)count;
    }
};

// Runs `task` on the MESSAGE thread as soon as possible (implemented by the engine's message loop;
// the VST3 layer uses it to get back onto the message thread from plugin callbacks that arrive
// on other threads).
using MessageTask = void (*)(void* context);
void postToMessageThread(MessageTask task, void* context);
bool isMessageThread();

// ---- implemented in src/vst3 ----
struct PluginListing {
    bool ok = false;
    std::string error;
    int exitCodeHint = 0;  // 3 = file not found, 4 = failed to load
    std::vector<PluginInfo> plugins;  // audio-effect classes only
};
PluginListing listVst3Plugins(const std::string& pluginPath);

struct PluginLoadResult {
    std::unique_ptr<IPluginInstance> plugin;
    std::string error;
    int exitCodeHint = 0;  // 3 = file not found, 4 = failed to load/initialize
    std::vector<std::string> warnings;
};
// MESSAGE thread. pluginName and classIdHex are optional selectors ("" = first audio effect).
PluginLoadResult createVst3Plugin(const std::string& pluginPath, const std::string& pluginName,
                                  const std::string& classIdHex, IPluginEvents* events);

// ---- host presentation and diagnostics (src/vst3; no-ops in the VST3-OFF stub) ----

// The name reported through VST3's IHostApplication::getName(). Process-wide, because a plugin
// asks an object it was handed rather than passing through anything we can scope. Empty string
// restores the default. Call before loading a plugin.
void setVst3HostName(const std::string& name);

// Record every interface a plugin asks OUR host-side objects for (host context, component
// handler, attribute/message bags, state streams, plug frame). Off by default; only the state
// interchange investigation and `--iid-log` turn it on.
void setVst3IidLogging(bool on);

struct Vst3IidQuery {
    std::string site;     // which object was asked
    std::string iid;      // 32 hex characters
    std::string name;     // SDK interface name when known, otherwise empty
    bool answered = false;
    long long count = 0;
};
std::vector<Vst3IidQuery> vst3IidQueries();

// ---- implemented in src/engine ----
std::unique_ptr<IPluginInstance> createNullPlugin(IPluginEvents* events);

}  // namespace thedaw
