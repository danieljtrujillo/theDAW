// The VST3 implementation of thedaw::IPluginInstance.
//
// One of these owns one loaded plugin: its module, its IComponent / IAudioProcessor /
// IEditController, the buffers its process() call needs, and its editor window.
//
// Thread discipline (the header's words, enforced here):
//   * everything except process(), resetDsp() and setParamNormalized() is message-thread only;
//   * process() and resetDsp() run on the realtime thread and never allocate, lock or log;
//   * setParamNormalized() may be called from anywhere and only touches lock-free rings;
//   * callbacks from the plugin can land on any thread and are hopped onto the message thread
//     through postToMessageThread() with at most one hop outstanding at a time.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"

#include "../plugin/IPluginInstance.h"

#include "vst3_common.h"
#include "vst3_editor.h"
#include "vst3_events.h"
#include "vst3_guard.h"
#include "vst3_host_context.h"
#include "vst3_module.h"
#include "vst3_param_changes.h"

namespace thedaw::vst3 {

class Vst3Instance final : public IPluginInstance, public HandlerSink, public EditorHost {
public:
    Vst3Instance(std::shared_ptr<Module> module, IPluginEvents* events);
    ~Vst3Instance() override;

    // Message thread. Brings up component + controller and wires them together.
    bool initialize(const ClassDescription& description, std::string& error,
                    std::vector<std::string>& warnings);

    // The IHostApplication this instance hands to the plugin. The factory needs to see it
    // before anything is instantiated.
    Steinberg::FUnknown* hostContext() { return &hostApplication_; }

    // ---- IPluginInstance, message thread ----
    PluginInfo info() const override { return info_; }
    bool hasEditor() const override { return hasEditor_; }
    PrepareResult prepare(const PrepareConfig& config) override;
    PrepareResult reprepare() override;
    void release() override;
    std::vector<ParamInfo> params() override;
    void paramValues(std::vector<double>& out) override;
    std::string paramText(std::int32_t index, double normalizedValue) override;
    bool getState(std::vector<std::uint8_t>& out, std::string& error) override;
    bool setState(const std::uint8_t* data, std::size_t size, std::string& error) override;
    // Truthful per instance: we can only claim one blob serves both the live host and the
    // offline renderer while this plugin still produces and takes a state at all.
    bool stateIsPedalboardCompatible() const override {
        return stateCompatible_ && !stateFaulted_;
    }
    bool openEditor(std::uint64_t parentHwnd, int x, int y, int w, int h, const std::string& title,
                    std::string& error) override;
    void setEditorRect(int x, int y, int w, int h) override;
    void closeEditor() override;
    bool editorOpen() const override { return editor_.isOpen(); }

    // ---- IPluginInstance, any thread ----
    void setParamNormalized(std::int32_t index, double value) override;

    // ---- IPluginInstance, audio thread ----
    void process(const float* const* in, float* const* out, std::int32_t frames,
                 const TransportInfo& transport) override;
    void flushParameters() override;
    void resetDsp() override;
    void setBlockMidi(const MidiEvent* events, std::int32_t count) override;

    // ---- HandlerSink (any thread) ----
    void handleBeginEdit(Steinberg::Vst::ParamID id) override;
    void handlePerformEdit(Steinberg::Vst::ParamID id, double normalizedValue) override;
    void handleEndEdit(Steinberg::Vst::ParamID id) override;
    void handleRestartComponent(Steinberg::int32 flags) override;

    // ---- EditorHost (message thread) ----
    void editorResized(int width, int height) override;
    void editorClosedByUser() override;

private:
    struct BusPlan {
        std::int32_t channels = 0;
        bool active = false;
        bool isMain = false;
    };

    // Message-thread work queued from other threads.
    void serviceOnMessageThread();
    void requestMessageThreadHop();
    static void messageThreadTrampoline(void* token);

    PrepareResult setUpProcessing(std::string& error);
    void tearDownProcessing();
    bool negotiateBuses(std::vector<std::string>& warnings, std::string& error);
    void allocateProcessBuffers();
    void refreshParameterCache();
    void applyRestartFlags(Steinberg::int32 flags);
    void pushEditToProcessor(Steinberg::Vst::ParamID id, double value);
    // Audio thread. Moves whatever setParamNormalized() queued into inputChanges_ at sample
    // offset 0; returns false when there was nothing to move. Allocation-free.
    bool drainEditsIntoInputChanges();
    // Message thread, audio parked. Reads the plugin's IMidiMapping into midiParam_: which
    // parameter each MIDI controller (and channel pressure, and the pitch wheel) drives on each
    // channel of event bus 0.
    void buildMidiMapping();
    // Audio thread. Turns this block's MIDI into note events and mapped parameter points.
    void fillBlockMidi();
    // Audio thread. Reports what the plugin wrote into outputChanges_ back to the message
    // thread, at most one message-thread hop per call. Allocation-free.
    void forwardOutputChanges();
    std::int32_t indexForParamId(Steinberg::Vst::ParamID id) const;
    void disconnectAndTerminate();
    // Runs one guarded plugin state call (a `StateCall`, opaque here). False when it faulted.
    bool runStateCall(void* callPtr, std::string& error);

    std::shared_ptr<Module> module_;
    IPluginEvents* events_ = nullptr;

    HostApplication hostApplication_;
    ComponentHandler handler_{this};
    EditorWindow editor_{this};

    ComPtr<Steinberg::Vst::IComponent> component_;
    ComPtr<Steinberg::Vst::IAudioProcessor> processor_;
    ComPtr<Steinberg::Vst::IEditController> controller_;
    ComPtr<Steinberg::Vst::IConnectionPoint> componentPoint_;
    ComPtr<Steinberg::Vst::IConnectionPoint> controllerPoint_;
    bool controllerIsComponent_ = false;
    bool componentInitialized_ = false;
    bool controllerInitialized_ = false;

    PluginInfo info_;
    bool hasEditor_ = false;
    bool stateCompatible_ = false;
    // Set once a plugin has faulted inside a state call: it is not asked again.
    bool stateFaulted_ = false;

    PrepareConfig config_;
    bool prepared_ = false;
    std::atomic<bool> active_{false};
    std::atomic<bool> processingOn_{false};

    std::vector<BusPlan> inputBuses_;
    std::vector<BusPlan> outputBuses_;
    std::int32_t channelsIn_ = 0;
    std::int32_t channelsOut_ = 0;
    std::int32_t latencySamples_ = 0;
    double tailSeconds_ = 0.0;

    // Preallocated process plumbing. Nothing below is touched outside prepare()/release() except
    // by process() itself, which only writes pointers and counts that already exist.
    Steinberg::Vst::ProcessData processData_{};
    // The zero-sample twin of processData_ used by flushParameters(): no buses, no buffers,
    // only the parameter changes. Built next to processData_ so the flush allocates nothing.
    Steinberg::Vst::ProcessData flushData_{};
    Steinberg::Vst::ProcessContext processContext_{};
    Steinberg::Vst::ProcessSetup processSetup_{};
    std::vector<Steinberg::Vst::AudioBusBuffers> inputBusBuffers_;
    std::vector<Steinberg::Vst::AudioBusBuffers> outputBusBuffers_;
    std::vector<std::vector<float*>> inputChannelPointers_;
    std::vector<std::vector<float*>> outputChannelPointers_;
    std::vector<float> silenceBuffer_;
    std::vector<float> discardBuffer_;  // where output the engine has no channel for goes; never read
    std::vector<std::vector<float>> scratchBuffers_;

    ParameterChanges inputChanges_;
    ParameterChanges outputChanges_;
    EventList inputEvents_;
    EventList outputEvents_;

    // The MIDI the next process() plays (setBlockMidi), valid until that call returns.
    const MidiEvent* blockMidi_ = nullptr;
    std::int32_t blockMidiCount_ = 0;
    // [channel * kMidiControllerSlots + controller] -> ParamID, or kNoMidiParam. Controllers
    // 0-127, then kAfterTouch (128) and kPitchBend (129). Written only while audio is parked.
    static constexpr std::int32_t kMidiControllerSlots = 130;
    static constexpr std::int64_t kNoMidiParam = -1;
    std::vector<std::int64_t> midiParam_;

    EditRing toProcessor_{1024};   // edits that must ride the next block
    EditRing toMessageThread_{1024};  // edits the message thread must mirror onto the controller

    std::vector<ParamInfo> paramCache_;
    std::vector<Steinberg::Vst::ParamID> paramIds_;

    std::atomic<Steinberg::int32> pendingRestartFlags_{0};
    std::atomic<bool> hopOutstanding_{false};
    std::atomic<bool> editorCloseRequested_{false};

    std::uint64_t token_ = 0;
};

}  // namespace thedaw::vst3
