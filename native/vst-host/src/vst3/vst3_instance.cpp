#include "vst3_instance.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>
#include <unordered_map>

#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/vstspeaker.h"

#include "vst3_guard.h"
#include "vst3_state_container.h"
#include "vst3_stream.h"

namespace thedaw::vst3 {
namespace {

// Live instances, so a message-thread hop posted from the audio thread can never land on a
// destroyed object. The audio thread only ever touches an atomic and postToMessageThread(); the
// lookup and the mutex are message-thread side.
std::mutex& registryMutex() {
    static std::mutex mutex;
    return mutex;
}

std::unordered_map<std::uint64_t, Vst3Instance*>& registry() {
    static std::unordered_map<std::uint64_t, Vst3Instance*> map;
    return map;
}

std::uint64_t nextToken() {
    static std::atomic<std::uint64_t> counter{1};
    return counter.fetch_add(1, std::memory_order_relaxed);
}

// How many distinct parameters one block may carry in each direction, and how many automation
// points a plugin may write for one of them. Both are generous for a live host and both exist
// only so process() never has to allocate.
constexpr std::size_t kMaxQueuesPerBlock = 512;
// Input: a set_param is one point at offset 0, and a mapped MIDI controller or wheel sweep adds
// one point per message, so a block of a fast pitch-bend curve still fits.
constexpr std::size_t kInputPointsPerQueue = 64;
// Note events one block can carry in each direction.
constexpr std::size_t kMaxEventsPerBlock = 1024;
constexpr std::size_t kOutputPointsPerQueue = 64;

Steinberg::Vst::SpeakerArrangement arrangementForChannels(std::int32_t channels) {
    switch (channels) {
        case 0: return 0;
        case 1: return Steinberg::Vst::SpeakerArr::kMono;
        case 2: return Steinberg::Vst::SpeakerArr::kStereo;
        default: break;
    }
    // Anything wider: the low `channels` speaker bits. Plugins that care will reject it and we
    // fall back to whatever they prefer.
    Steinberg::Vst::SpeakerArrangement arrangement = 0;
    for (std::int32_t i = 0; i < channels && i < 64; ++i) {
        arrangement |= (static_cast<Steinberg::Vst::SpeakerArrangement>(1) << i);
    }
    return arrangement;
}

std::int32_t channelsInArrangement(Steinberg::Vst::SpeakerArrangement arrangement) {
    std::int32_t count = 0;
    for (int i = 0; i < 64; ++i) {
        if ((arrangement >> i) & 1u) ++count;
    }
    return count;
}

}  // namespace

Vst3Instance::Vst3Instance(std::shared_ptr<Module> module, IPluginEvents* events)
    : module_(std::move(module)), events_(events), token_(nextToken()) {
    std::lock_guard<std::mutex> lock(registryMutex());
    registry()[token_] = this;
}

Vst3Instance::~Vst3Instance() {
    {
        std::lock_guard<std::mutex> lock(registryMutex());
        registry().erase(token_);
    }
    editor_.close();
    tearDownProcessing();
    disconnectAndTerminate();
    // The handler can outlive us if a plugin kept a reference; make sure it can never reach a
    // destroyed sink.
    handler_.detach();
    processor_.reset();
    controller_.reset();
    component_.reset();
    // module_ last: unloading the DLL before its objects are gone is a crash.
    module_.reset();
}

// ---------------------------------------------------------------------------------------------
// Bring-up
// ---------------------------------------------------------------------------------------------

bool Vst3Instance::initialize(const ClassDescription& description, std::string& error,
                              std::vector<std::string>& warnings) {
    error.clear();
    Steinberg::IPluginFactory* factory = module_->factory();
    if (factory == nullptr) {
        error = "the plugin module has no factory";
        return false;
    }

    void* rawComponent = nullptr;
    if (factory->createInstance(description.cid, Steinberg::Vst::IComponent::iid, &rawComponent) !=
            Steinberg::kResultOk ||
        rawComponent == nullptr) {
        error = "the factory refused to create '" + description.name + "'";
        return false;
    }
    component_ = ComPtr<Steinberg::Vst::IComponent>::adopt(
        static_cast<Steinberg::Vst::IComponent*>(rawComponent));

    if (component_->initialize(&hostApplication_) != Steinberg::kResultOk) {
        error = "'" + description.name + "' failed to initialise";
        return false;
    }
    componentInitialized_ = true;

    processor_ = queryFor<Steinberg::Vst::IAudioProcessor>(component_.get());
    if (!processor_) {
        error = "'" + description.name + "' is not an audio processor";
        return false;
    }

    // Two shapes exist: one object that is both halves, or a separate controller class named by
    // the component. Try the cheap case first.
    controller_ = queryFor<Steinberg::Vst::IEditController>(component_.get());
    if (controller_) {
        controllerIsComponent_ = true;
    } else {
        Steinberg::TUID controllerCid{};
        if (component_->getControllerClassId(controllerCid) == Steinberg::kResultOk) {
            void* rawController = nullptr;
            if (factory->createInstance(controllerCid, Steinberg::Vst::IEditController::iid,
                                        &rawController) == Steinberg::kResultOk &&
                rawController != nullptr) {
                controller_ = ComPtr<Steinberg::Vst::IEditController>::adopt(
                    static_cast<Steinberg::Vst::IEditController*>(rawController));
                if (controller_->initialize(&hostApplication_) == Steinberg::kResultOk) {
                    controllerInitialized_ = true;
                } else {
                    warnings.push_back("the plugin's edit controller failed to initialise; "
                                       "parameters and the editor are unavailable");
                    controller_.reset();
                }
            }
        }
        if (!controller_) {
            warnings.push_back("this plugin exposes no edit controller: no parameters, no editor");
        }
    }

    if (controller_) {
        controller_->setComponentHandler(&handler_);

        // Connect the two halves so they can exchange IMessage traffic. Both directions, or the
        // plugin only hears one side of its own conversation.
        componentPoint_ = queryFor<Steinberg::Vst::IConnectionPoint>(component_.get());
        controllerPoint_ = queryFor<Steinberg::Vst::IConnectionPoint>(controller_.get());
        if (componentPoint_ && controllerPoint_ && !controllerIsComponent_) {
            componentPoint_->connect(controllerPoint_.get());
            controllerPoint_->connect(componentPoint_.get());
        }

        // Hand the controller the component's current state so the two start in step.
        if (!controllerIsComponent_) {
            MemoryStream stream;
            if (component_->getState(&stream) == Steinberg::kResultOk) {
                stream.rewind();
                // The result is deliberately ignored. Measured on this machine, AIR Vocal
                // Doubler, Cymatics Corrosion and Accentize dxRevive Pro all answer something
                // other than kResultOk here while working perfectly afterwards: plenty of
                // controllers return kResultFalse to mean "nothing for me in there". Treating
                // that as a failure would mislabel most of the installed plugins.
                controller_->setComponentState(&stream);
            }
        }

        Steinberg::IPlugView* probe = tryCreatingView(controller_.get());
        if (probe != nullptr) {
            hasEditor_ = true;
            probe->release();
        }
    }

    info_.name = description.name;
    info_.vendor = description.vendor.empty() ? module_->factoryVendor() : description.vendor;
    info_.version = description.version;
    info_.category = description.subCategories;
    info_.identifier = description.identifier;
    info_.format = "VST3";

    refreshParameterCache();
    return true;
}

void Vst3Instance::disconnectAndTerminate() {
    if (controller_) controller_->setComponentHandler(nullptr);
    if (componentPoint_ && controllerPoint_ && !controllerIsComponent_) {
        componentPoint_->disconnect(controllerPoint_.get());
        controllerPoint_->disconnect(componentPoint_.get());
    }
    componentPoint_.reset();
    controllerPoint_.reset();

    if (controllerInitialized_ && controller_) {
        controller_->terminate();
        controllerInitialized_ = false;
    }
    if (componentInitialized_ && component_) {
        component_->terminate();
        componentInitialized_ = false;
    }
}

// ---------------------------------------------------------------------------------------------
// Buses and processing setup
// ---------------------------------------------------------------------------------------------

bool Vst3Instance::negotiateBuses(std::vector<std::string>& warnings, std::string& error) {
    inputBuses_.clear();
    outputBuses_.clear();

    const std::int32_t inputBusCount =
        component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kInput);
    const std::int32_t outputBusCount =
        component_->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput);

    if (outputBusCount <= 0) {
        error = "this plugin has no audio output bus, so it cannot sit in an effect chain";
        return false;
    }

    const Steinberg::Vst::SpeakerArrangement wanted = arrangementForChannels(config_.requestedChannels);

    // The way JUCE's VST3 host negotiates (prepareToPlay / syncBusLayouts):
    //  - EVERY bus is handed a real arrangement. The main bus of each direction gets the layout
    //    the engine wants; every other bus keeps the one the plugin already has for it. This host
    //    used to pass 0 for those, and a plugin that validates the whole array refuses a 0 on a
    //    bus it declares as stereo — taking the main bus request down with it.
    //  - setBusArrangements never sees a null pointer: some plugins crash on one.
    //  - What the plugin ends up with is read back and compared with what was asked.
    auto currentArrangements = [&](Steinberg::Vst::BusDirection direction, std::int32_t count) {
        std::vector<Steinberg::Vst::SpeakerArrangement> out(static_cast<std::size_t>(std::max(0, count)), 0);
        for (std::int32_t i = 0; i < count; ++i) {
            Steinberg::Vst::SpeakerArrangement current = 0;
            if (processor_->getBusArrangement(direction, i, current) == Steinberg::kResultOk) {
                out[static_cast<std::size_t>(i)] = current;
            }
        }
        return out;
    };
    auto apply = [&](std::vector<Steinberg::Vst::SpeakerArrangement>& ins,
                     std::vector<Steinberg::Vst::SpeakerArrangement>& outs) {
        Steinberg::Vst::SpeakerArrangement none = 0;
        return processor_->setBusArrangements(ins.empty() ? &none : ins.data(),
                                              static_cast<Steinberg::int32>(ins.size()),
                                              outs.empty() ? &none : outs.data(),
                                              static_cast<Steinberg::int32>(outs.size()));
    };

    std::vector<Steinberg::Vst::SpeakerArrangement> inputArrangements =
        currentArrangements(Steinberg::Vst::kInput, inputBusCount);
    std::vector<Steinberg::Vst::SpeakerArrangement> outputArrangements =
        currentArrangements(Steinberg::Vst::kOutput, outputBusCount);
    if (!inputArrangements.empty()) inputArrangements[0] = wanted;
    outputArrangements[0] = wanted;

    const Steinberg::tresult negotiated = apply(inputArrangements, outputArrangements);
    const bool took = negotiated == Steinberg::kResultOk &&
                      currentArrangements(Steinberg::Vst::kInput, inputBusCount) == inputArrangements &&
                      currentArrangements(Steinberg::Vst::kOutput, outputBusCount) == outputArrangements;
    if (!took) {
        // Refused, or accepted and then not applied. Confirm the layout the plugin itself reports
        // — explicitly, because some plugins will not activate until ONE setBusArrangements call
        // has succeeded — and let the engine adapt to the real channel counts.
        std::vector<Steinberg::Vst::SpeakerArrangement> ownIn =
            currentArrangements(Steinberg::Vst::kInput, inputBusCount);
        std::vector<Steinberg::Vst::SpeakerArrangement> ownOut =
            currentArrangements(Steinberg::Vst::kOutput, outputBusCount);
        apply(ownIn, ownOut);
        warnings.push_back("this plugin would not take a " +
                           std::to_string(config_.requestedChannels) +
                           "-channel layout; using its own preferred bus layout instead");
    }

    auto readBus = [&](Steinberg::Vst::BusDirection direction, std::int32_t index) {
        BusPlan plan;
        Steinberg::Vst::BusInfo busInfo{};
        if (component_->getBusInfo(Steinberg::Vst::kAudio, direction, index, busInfo) ==
            Steinberg::kResultOk) {
            plan.isMain = busInfo.busType == Steinberg::Vst::kMain;
            plan.channels = busInfo.channelCount;
        }
        Steinberg::Vst::SpeakerArrangement actual = 0;
        if (processor_->getBusArrangement(direction, index, actual) == Steinberg::kResultOk) {
            const std::int32_t fromArrangement = channelsInArrangement(actual);
            if (fromArrangement > 0) plan.channels = fromArrangement;
        }
        // Bus 0 carries the chain signal. Any other bus follows the plugin's own default, as it
        // does in JUCE (BusInfo::kDefaultActive): an aux bus the plugin expects to be on is on,
        // fed silence on the way in and drained into scratch on the way out.
        plan.active = index == 0 || (busInfo.flags & Steinberg::Vst::BusInfo::kDefaultActive) != 0;
        return plan;
    };

    for (std::int32_t i = 0; i < inputBusCount; ++i) inputBuses_.push_back(readBus(Steinberg::Vst::kInput, i));
    for (std::int32_t i = 0; i < outputBusCount; ++i) outputBuses_.push_back(readBus(Steinberg::Vst::kOutput, i));

    for (std::int32_t i = 0; i < inputBusCount; ++i) {
        component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, i,
                                inputBuses_[static_cast<std::size_t>(i)].active);
    }
    for (std::int32_t i = 0; i < outputBusCount; ++i) {
        component_->activateBus(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, i,
                                outputBuses_[static_cast<std::size_t>(i)].active);
    }
    // Event buses stay on and get an empty list every block; a deactivated event bus makes some
    // plugins skip their own parameter smoothing.
    const std::int32_t eventIn = component_->getBusCount(Steinberg::Vst::kEvent, Steinberg::Vst::kInput);
    const std::int32_t eventOut = component_->getBusCount(Steinberg::Vst::kEvent, Steinberg::Vst::kOutput);
    // ALL of them, both directions (JUCE: setStateForAllMidiBuses), and off again at teardown.
    for (std::int32_t i = 0; i < eventIn; ++i) {
        component_->activateBus(Steinberg::Vst::kEvent, Steinberg::Vst::kInput, i, true);
    }
    for (std::int32_t i = 0; i < eventOut; ++i) {
        component_->activateBus(Steinberg::Vst::kEvent, Steinberg::Vst::kOutput, i, true);
    }

    channelsIn_ = inputBuses_.empty() ? 0 : inputBuses_.front().channels;
    channelsOut_ = outputBuses_.front().channels;
    if (channelsOut_ <= 0) {
        error = "this plugin reports no channels on its main output bus";
        return false;
    }
    if (channelsIn_ != config_.requestedChannels || channelsOut_ != config_.requestedChannels) {
        warnings.push_back("bus layout settled at " + std::to_string(channelsIn_) + " in / " +
                           std::to_string(channelsOut_) + " out (asked for " +
                           std::to_string(config_.requestedChannels) + ")");
    }
    return true;
}

void Vst3Instance::allocateProcessBuffers() {
    const std::size_t frames = static_cast<std::size_t>(std::max(1, config_.maxBlockSize));

    silenceBuffer_.assign(frames, 0.0f);
    discardBuffer_.assign(frames, 0.0f);
    scratchBuffers_.clear();
    inputChannelPointers_.assign(inputBuses_.size(), {});
    outputChannelPointers_.assign(outputBuses_.size(), {});
    inputBusBuffers_.assign(inputBuses_.size(), Steinberg::Vst::AudioBusBuffers{});
    outputBusBuffers_.assign(outputBuses_.size(), Steinberg::Vst::AudioBusBuffers{});

    // Every non-main output channel needs somewhere real to be written; count them first so the
    // vector never reallocates and invalidates the pointers we are about to hand out.
    std::size_t scratchChannels = 0;
    for (std::size_t bus = 1; bus < outputBuses_.size(); ++bus) {
        scratchChannels += static_cast<std::size_t>(std::max(0, outputBuses_[bus].channels));
    }
    scratchBuffers_.assign(scratchChannels, std::vector<float>(frames, 0.0f));

    std::size_t nextScratch = 0;
    for (std::size_t bus = 0; bus < inputBuses_.size(); ++bus) {
        const std::size_t channels = static_cast<std::size_t>(std::max(0, inputBuses_[bus].channels));
        inputChannelPointers_[bus].assign(channels, nullptr);
        for (std::size_t ch = 0; ch < channels; ++ch) {
            // Bus 0's pointers are replaced by the caller's buffers every block; the rest stay
            // pointed at silence for good.
            inputChannelPointers_[bus][ch] = silenceBuffer_.data();
        }
        inputBusBuffers_[bus].numChannels = static_cast<Steinberg::int32>(channels);
        inputBusBuffers_[bus].silenceFlags = bus == 0 ? 0 : ~Steinberg::uint64(0);
        inputBusBuffers_[bus].channelBuffers32 =
            channels > 0 ? inputChannelPointers_[bus].data() : nullptr;
    }
    for (std::size_t bus = 0; bus < outputBuses_.size(); ++bus) {
        const std::size_t channels = static_cast<std::size_t>(std::max(0, outputBuses_[bus].channels));
        outputChannelPointers_[bus].assign(channels, nullptr);
        for (std::size_t ch = 0; ch < channels; ++ch) {
            outputChannelPointers_[bus][ch] =
                bus == 0 ? nullptr : scratchBuffers_[nextScratch++].data();
        }
        outputBusBuffers_[bus].numChannels = static_cast<Steinberg::int32>(channels);
        outputBusBuffers_[bus].silenceFlags = 0;
        outputBusBuffers_[bus].channelBuffers32 =
            channels > 0 ? outputChannelPointers_[bus].data() : nullptr;
    }

    inputChanges_.reserve(kMaxQueuesPerBlock, kInputPointsPerQueue);
    outputChanges_.reserve(kMaxQueuesPerBlock, kOutputPointsPerQueue);
    inputEvents_.reserve(kMaxEventsPerBlock);
    outputEvents_.reserve(kMaxEventsPerBlock);

    processContext_ = Steinberg::Vst::ProcessContext{};
    processContext_.sampleRate = config_.sampleRate;

    processData_ = Steinberg::Vst::ProcessData{};
    processData_.processMode = processSetup_.processMode;
    processData_.symbolicSampleSize = Steinberg::Vst::kSample32;
    processData_.numInputs = static_cast<Steinberg::int32>(inputBusBuffers_.size());
    processData_.numOutputs = static_cast<Steinberg::int32>(outputBusBuffers_.size());
    processData_.inputs = inputBusBuffers_.empty() ? nullptr : inputBusBuffers_.data();
    processData_.outputs = outputBusBuffers_.empty() ? nullptr : outputBusBuffers_.data();
    processData_.inputParameterChanges = &inputChanges_;
    processData_.outputParameterChanges = &outputChanges_;
    processData_.inputEvents = &inputEvents_;
    processData_.outputEvents = &outputEvents_;
    processData_.processContext = &processContext_;

    // Parameter flush: the VST3 way to hand a plugin a parameter change while no audio is
    // flowing is a process call with numSamples = 0 and no buses at all, carrying only
    // inputParameterChanges. Sharing the change lists with processData_ is safe because both
    // calls happen on the audio thread and never overlap.
    flushData_ = Steinberg::Vst::ProcessData{};
    flushData_.processMode = processSetup_.processMode;
    flushData_.symbolicSampleSize = Steinberg::Vst::kSample32;
    flushData_.numSamples = 0;
    flushData_.numInputs = 0;
    flushData_.numOutputs = 0;
    flushData_.inputs = nullptr;
    flushData_.outputs = nullptr;
    flushData_.inputParameterChanges = &inputChanges_;
    flushData_.outputParameterChanges = &outputChanges_;
    // The flush carries parameters only: its event lists are the same objects, cleared first.
    flushData_.inputEvents = &inputEvents_;
    flushData_.outputEvents = &outputEvents_;
    flushData_.processContext = &processContext_;
}

PrepareResult Vst3Instance::setUpProcessing(std::string& error) {
    PrepareResult result;

    if (!negotiateBuses(result.warnings, error)) {
        result.ok = false;
        result.error = error;
        return result;
    }

    processSetup_ = Steinberg::Vst::ProcessSetup{};
    // kOffline tells a plugin it is rendering rather than playing, which is how lookahead and
    // oversampling stages know they may take their time. The live session never sets this.
    processSetup_.processMode =
        config_.offline ? Steinberg::Vst::kOffline : Steinberg::Vst::kRealtime;
    processSetup_.symbolicSampleSize = Steinberg::Vst::kSample32;
    processSetup_.maxSamplesPerBlock = config_.maxBlockSize;
    processSetup_.sampleRate = config_.sampleRate;
    if (processor_->setupProcessing(processSetup_) != Steinberg::kResultOk) {
        result.ok = false;
        result.error = "the plugin rejected " + std::to_string(config_.sampleRate) +
                       " Hz at a block size of " + std::to_string(config_.maxBlockSize);
        error = result.error;
        return result;
    }

    allocateProcessBuffers();

    if (component_->setActive(true) != Steinberg::kResultOk) {
        result.ok = false;
        result.error = "the plugin refused to activate";
        error = result.error;
        return result;
    }
    active_.store(true, std::memory_order_release);
    processor_->setProcessing(true);
    processingOn_.store(true, std::memory_order_release);

    latencySamples_ = static_cast<std::int32_t>(processor_->getLatencySamples());
    const Steinberg::uint32 tailSamples = processor_->getTailSamples();
    if (tailSamples == Steinberg::Vst::kInfiniteTail) {
        tailSeconds_ = -1.0;
    } else {
        tailSeconds_ = config_.sampleRate > 0 ? static_cast<double>(tailSamples) / config_.sampleRate : 0.0;
    }

    // Truthful state compatibility, measured rather than assumed: capture a container, hand it
    // straight back, and require the controller to have stayed in step with the component. A
    // plugin that will not take its own state back, or whose controller ignores the component
    // state, cannot have ONE blob serve both this host and the offline renderer.
    //
    // What this CANNOT prove is interchange with the offline renderer's own host, which is a
    // property of the plugin's serialisation, not of the container. Measurements for the plugins
    // on this machine are in the ticket report.
    stateCompatible_ = false;
    if (!stateFaulted_) {
        std::vector<std::uint8_t> captured;
        std::string stateError;
        if (getState(captured, stateError) && !captured.empty()) {
            const bool restored = setState(captured.data(), captured.size(), stateError);
            stateCompatible_ = restored && !stateFaulted_;
            if (!stateCompatible_) {
                result.warnings.push_back(
                    "this plugin does not reliably round-trip its own state, so its live state is "
                    "kept separately from the one the offline renderer uses");
            }
        }
    }

    refreshParameterCache();
    buildMidiMapping();

    result.ok = true;
    result.channelsIn = channelsIn_;
    result.channelsOut = channelsOut_;
    result.latencySamples = latencySamples_;
    result.tailSeconds = tailSeconds_;
    prepared_ = true;
    return result;
}

PrepareResult Vst3Instance::prepare(const PrepareConfig& config) {
    config_ = config;
    if (config_.maxBlockSize <= 0) config_.maxBlockSize = 512;
    if (config_.sampleRate <= 0) config_.sampleRate = 48000;
    if (config_.requestedChannels <= 0) config_.requestedChannels = 2;

    tearDownProcessing();
    std::string error;
    return setUpProcessing(error);
}

PrepareResult Vst3Instance::reprepare() {
    tearDownProcessing();
    std::string error;
    return setUpProcessing(error);
}

void Vst3Instance::tearDownProcessing() {
    if (processingOn_.exchange(false, std::memory_order_acq_rel) && processor_) {
        processor_->setProcessing(false);
    }
    if (active_.exchange(false, std::memory_order_acq_rel) && component_) {
        component_->setActive(false);
        // The mirror of the activation in negotiateBuses (JUCE's deactivate() does the same).
        const std::int32_t eventIn = component_->getBusCount(Steinberg::Vst::kEvent, Steinberg::Vst::kInput);
        const std::int32_t eventOut = component_->getBusCount(Steinberg::Vst::kEvent, Steinberg::Vst::kOutput);
        for (std::int32_t i = 0; i < eventIn; ++i) {
            component_->activateBus(Steinberg::Vst::kEvent, Steinberg::Vst::kInput, i, false);
        }
        for (std::int32_t i = 0; i < eventOut; ++i) {
            component_->activateBus(Steinberg::Vst::kEvent, Steinberg::Vst::kOutput, i, false);
        }
    }
    prepared_ = false;
}

void Vst3Instance::release() { tearDownProcessing(); }

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

void Vst3Instance::refreshParameterCache() {
    paramCache_.clear();
    paramIds_.clear();
    if (!controller_) return;

    const Steinberg::int32 count = controller_->getParameterCount();
    paramCache_.reserve(static_cast<std::size_t>(std::max(0, count)));
    paramIds_.reserve(static_cast<std::size_t>(std::max(0, count)));

    for (Steinberg::int32 i = 0; i < count; ++i) {
        Steinberg::Vst::ParameterInfo raw{};
        // A parameter the controller will not describe still takes its slot: the list mirrors the
        // controller index for index (JUCE's VST3 host keeps every parameter), so `index` means
        // the same thing here as in any other host and never shifts when a flag changes.
        const bool described = controller_->getParameterInfo(i, raw) == Steinberg::kResultOk;
        if (!described) raw.id = Steinberg::Vst::kNoParamId;  // a slot, not something to write to

        ParamInfo info;
        info.index = static_cast<std::int32_t>(paramCache_.size());
        info.id = static_cast<std::uint32_t>(raw.id);
        info.name = fromVstString(raw.title, sizeof(raw.title) / sizeof(raw.title[0]));
        info.label = fromVstString(raw.units, sizeof(raw.units) / sizeof(raw.units[0]));
        info.defaultValue = raw.defaultNormalizedValue;
        info.value = controller_->getParamNormalized(raw.id);
        info.steps = static_cast<std::int32_t>(raw.stepCount);
        info.automatable = (raw.flags & Steinberg::Vst::ParameterInfo::kCanAutomate) != 0 &&
                           (raw.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) == 0;
        info.discrete = raw.stepCount > 0 ||
                        (raw.flags & Steinberg::Vst::ParameterInfo::kIsList) != 0;
        info.boolean_ = raw.stepCount == 1;
        info.hidden = !described || (raw.flags & Steinberg::Vst::ParameterInfo::kIsHidden) != 0;
        info.readOnly = (raw.flags & Steinberg::Vst::ParameterInfo::kIsReadOnly) != 0;
        info.isBypass = (raw.flags & Steinberg::Vst::ParameterInfo::kIsBypass) != 0;
        info.isProgramChange = (raw.flags & Steinberg::Vst::ParameterInfo::kIsProgramChange) != 0;
        if (info.hidden) info.automatable = false;  // automating book-keeping is undefined
        paramCache_.push_back(std::move(info));
        paramIds_.push_back(raw.id);
    }
}

std::vector<ParamInfo> Vst3Instance::params() {
    if (controller_) {
        // Values move under us (automation, presets, the editor); names and flags do not.
        for (std::size_t i = 0; i < paramCache_.size(); ++i) {
            if (paramIds_[i] == Steinberg::Vst::kNoParamId) continue;
            paramCache_[i].value = controller_->getParamNormalized(paramIds_[i]);
            paramCache_[i].text = paramCache_[i].hidden
                                      ? std::string()
                                      : paramText(static_cast<std::int32_t>(i), paramCache_[i].value);
        }
    }
    return paramCache_;
}

void Vst3Instance::paramValues(std::vector<double>& out) {
    out.resize(paramIds_.size());
    for (std::size_t i = 0; i < paramIds_.size(); ++i) {
        if (controller_ && paramIds_[i] != Steinberg::Vst::kNoParamId) {
            paramCache_[i].value = controller_->getParamNormalized(paramIds_[i]);
        }
        out[i] = paramCache_[i].value;
    }
}

std::string Vst3Instance::paramText(std::int32_t index, double normalizedValue) {
    if (!controller_ || index < 0 || static_cast<std::size_t>(index) >= paramIds_.size()) return {};
    if (paramIds_[static_cast<std::size_t>(index)] == Steinberg::Vst::kNoParamId) return {};
    const double value = normalizedValue < 0.0 ? 0.0 : (normalizedValue > 1.0 ? 1.0 : normalizedValue);
    Steinberg::Vst::String128 text{};
    if (controller_->getParamStringByValue(paramIds_[static_cast<std::size_t>(index)], value, text) !=
        Steinberg::kResultOk) {
        return {};
    }
    return fromVstString(text, sizeof(text) / sizeof(text[0]));
}

std::int32_t Vst3Instance::indexForParamId(Steinberg::Vst::ParamID id) const {
    for (std::size_t i = 0; i < paramIds_.size(); ++i) {
        if (paramIds_[i] == id) return static_cast<std::int32_t>(i);
    }
    return -1;
}

void Vst3Instance::pushEditToProcessor(Steinberg::Vst::ParamID id, double value) {
    ParamEdit edit;
    edit.id = id;
    edit.value = value < 0.0 ? 0.0 : (value > 1.0 ? 1.0 : value);
    toProcessor_.push(edit);
}

void Vst3Instance::setParamNormalized(std::int32_t index, double value) {
    if (index < 0 || static_cast<std::size_t>(index) >= paramIds_.size()) return;
    const Steinberg::Vst::ParamID id = paramIds_[static_cast<std::size_t>(index)];
    if (id == Steinberg::Vst::kNoParamId) return;  // a slot the controller would not describe

    // The processor is the thing making sound, so it hears about this through the block's
    // parameter changes; the controller has to be told separately or an open editor will not
    // move. The controller call is message-thread only, hence the hop.
    pushEditToProcessor(id, value);

    ParamEdit mirror;
    mirror.id = id;
    mirror.value = value;
    mirror.fromHost = true;
    toMessageThread_.push(mirror);
    if (isMessageThread()) {
        serviceOnMessageThread();
    } else {
        requestMessageThreadHop();
    }
}

// ---------------------------------------------------------------------------------------------
// Plugin callbacks
// ---------------------------------------------------------------------------------------------

// beginEdit / endEdit are the boundaries of one gesture in the plugin's own window (JUCE turns
// them into beginChangeGesture / endChangeGesture). Reported from the message thread only: a
// boundary is advice to the app about grouping, and one that arrives on another thread is
// not worth a queue of its own.
void Vst3Instance::handleBeginEdit(Steinberg::Vst::ParamID id) {
    if (!isMessageThread() || events_ == nullptr) return;
    const std::int32_t index = indexForParamId(id);
    if (index >= 0) events_->onParamGesture(index, true);
}

void Vst3Instance::handleEndEdit(Steinberg::Vst::ParamID id) {
    if (!isMessageThread() || events_ == nullptr) return;
    const std::int32_t index = indexForParamId(id);
    if (index >= 0) events_->onParamGesture(index, false);
}

void Vst3Instance::handlePerformEdit(Steinberg::Vst::ParamID id, double normalizedValue) {
    // The user moved a control in the editor. The component does NOT hear that by itself, so the
    // value has to be pushed into the processor's input queue as well as reported upwards.
    pushEditToProcessor(id, normalizedValue);

    if (isMessageThread()) {
        const std::int32_t index = indexForParamId(id);
        if (index >= 0) {
            paramCache_[static_cast<std::size_t>(index)].value = normalizedValue;
            if (events_ != nullptr) events_->onParamEdited(index, normalizedValue);
        }
        return;
    }
    ParamEdit edit;
    edit.id = id;
    edit.value = normalizedValue;
    toMessageThread_.push(edit);
    requestMessageThreadHop();
}

void Vst3Instance::handleRestartComponent(Steinberg::int32 flags) {
    pendingRestartFlags_.fetch_or(flags, std::memory_order_acq_rel);
    if (isMessageThread()) {
        serviceOnMessageThread();
    } else {
        requestMessageThreadHop();
    }
}

void Vst3Instance::applyRestartFlags(Steinberg::int32 flags) {
    if (flags == 0) return;

    if ((flags & Steinberg::Vst::kParamTitlesChanged) != 0) {
        refreshParameterCache();
    }

    if ((flags & Steinberg::Vst::kLatencyChanged) != 0 && processor_) {
        const std::int32_t latency = static_cast<std::int32_t>(processor_->getLatencySamples());
        if (latency != latencySamples_) {
            latencySamples_ = latency;
            if (events_ != nullptr) events_->onLatencyChanged(latency);
        }
    }

    if ((flags & Steinberg::Vst::kParamValuesChanged) != 0 && controller_) {
        // Coalesced by construction: the flags were OR'd together and we are re-reading the
        // whole list once, not once per parameter the plugin touched.
        for (std::size_t i = 0; i < paramCache_.size(); ++i) {
            const double value = controller_->getParamNormalized(paramIds_[i]);
            if (value != paramCache_[i].value) {
                paramCache_[i].value = value;
                if (events_ != nullptr) {
                    events_->onParamEdited(static_cast<std::int32_t>(i), value);
                }
            }
        }
    }

    // A changed I/O layout or a reloaded component cannot be applied while the plugin is
    // active, so the engine has to park audio and call reprepare(). Latency alone does not
    // need that: the host just recomputes its delay compensation.
    if ((flags & (Steinberg::Vst::kIoChanged | Steinberg::Vst::kReloadComponent)) != 0) {
        if (events_ != nullptr) events_->onRestartRequired();
    }
}

void Vst3Instance::requestMessageThreadHop() {
    bool expected = false;
    if (hopOutstanding_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        postToMessageThread(&Vst3Instance::messageThreadTrampoline,
                            reinterpret_cast<void*>(static_cast<std::uintptr_t>(token_)));
    }
}

void Vst3Instance::messageThreadTrampoline(void* token) {
    Vst3Instance* instance = nullptr;
    {
        std::lock_guard<std::mutex> lock(registryMutex());
        auto it = registry().find(static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(token)));
        if (it != registry().end()) instance = it->second;
    }
    if (instance != nullptr) instance->serviceOnMessageThread();
}

void Vst3Instance::serviceOnMessageThread() {
    // Clear the latch first so work arriving while we drain schedules another hop instead of
    // being lost.
    hopOutstanding_.store(false, std::memory_order_release);

    ParamEdit edit;
    while (toMessageThread_.pop(edit)) {
        const std::int32_t index = indexForParamId(edit.id);
        if (index < 0) continue;
        if (controller_) controller_->setParamNormalized(edit.id, edit.value);
        if (paramCache_[static_cast<std::size_t>(index)].value != edit.value) {
            paramCache_[static_cast<std::size_t>(index)].value = edit.value;
            // Reported only when the PLUGIN moved it; the app already knows what it set itself.
            if (!edit.fromHost && events_ != nullptr) events_->onParamEdited(index, edit.value);
        }
    }

    const Steinberg::int32 flags = pendingRestartFlags_.exchange(0, std::memory_order_acq_rel);
    applyRestartFlags(flags);

    if (editorCloseRequested_.exchange(false, std::memory_order_acq_rel)) {
        editor_.close();
        if (events_ != nullptr) events_->onEditorClosed();
    }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

namespace {

// One plugin state call, in the shape runGuarded() needs: a plain function plus a POD context.
struct StateCall {
    enum class Kind { componentGet, componentSet, controllerGet, controllerSet, controllerComponentSet };

    Kind kind = Kind::componentGet;
    Steinberg::Vst::IComponent* component = nullptr;
    Steinberg::Vst::IEditController* controller = nullptr;
    Steinberg::IBStream* stream = nullptr;
    Steinberg::tresult result = Steinberg::kResultFalse;
};

void invokeStateCall(void* context) {
    StateCall* call = static_cast<StateCall*>(context);
    switch (call->kind) {
        case StateCall::Kind::componentGet:
            call->result = call->component->getState(call->stream);
            break;
        case StateCall::Kind::componentSet:
            call->result = call->component->setState(call->stream);
            break;
        case StateCall::Kind::controllerGet:
            call->result = call->controller->getState(call->stream);
            break;
        case StateCall::Kind::controllerSet:
            call->result = call->controller->setState(call->stream);
            break;
        case StateCall::Kind::controllerComponentSet:
            call->result = call->controller->setComponentState(call->stream);
            break;
    }
}

const char* nameOf(StateCall::Kind kind) {
    switch (kind) {
        case StateCall::Kind::componentGet: return "IComponent::getState";
        case StateCall::Kind::componentSet: return "IComponent::setState";
        case StateCall::Kind::controllerGet: return "IEditController::getState";
        case StateCall::Kind::controllerSet: return "IEditController::setState";
        case StateCall::Kind::controllerComponentSet: return "IEditController::setComponentState";
    }
    return "a state call";
}

}  // namespace

bool Vst3Instance::runStateCall(void* callPtr, std::string& error) {
    StateCall* call = static_cast<StateCall*>(callPtr);
    std::uint32_t faultCode = 0;
    if (runGuarded(&invokeStateCall, call, faultCode)) return true;

    stateFaulted_ = true;
    error = std::string("the plugin crashed (") + describeFault(faultCode) + ") inside " +
            nameOf(call->kind) + "; this state blob does not belong to it";
    if (events_ != nullptr) events_->onWarning(error);
    return false;
}

bool Vst3Instance::getState(std::vector<std::uint8_t>& out, std::string& error) {
    out.clear();
    error.clear();
    if (!component_) {
        error = "no plugin is loaded";
        return false;
    }
    if (stateFaulted_) {
        error = "this plugin faulted on an earlier state call and cannot be trusted with another";
        return false;
    }

    PluginStateBlob blob;
    MemoryStream componentStream;
    StateCall call;
    call.kind = StateCall::Kind::componentGet;
    call.component = component_.get();
    call.stream = &componentStream;
    if (!runStateCall(&call, error)) return false;
    if (call.result != Steinberg::kResultOk) {
        error = "the plugin would not hand over its component state";
        return false;
    }
    blob.component = componentStream.takeBytes();

    if (controller_) {
        MemoryStream controllerStream;
        StateCall controllerCall;
        controllerCall.kind = StateCall::Kind::controllerGet;
        controllerCall.controller = controller_.get();
        controllerCall.stream = &controllerStream;
        std::string ignored;
        if (runStateCall(&controllerCall, ignored) &&
            controllerCall.result == Steinberg::kResultOk) {
            blob.controller = controllerStream.takeBytes();
            blob.hasController = true;
        }
    }
    out = writeStateContainer(blob);
    return true;
}

bool Vst3Instance::setState(const std::uint8_t* data, std::size_t size, std::string& error) {
    error.clear();
    if (!component_) {
        error = "no plugin is loaded";
        return false;
    }
    if (stateFaulted_) {
        error = "this plugin faulted on an earlier state call and cannot be trusted with another";
        return false;
    }

    PluginStateBlob blob;
    if (!readStateContainer(data, size, blob, error)) return false;

    // Order is fixed by the format: the component takes the state, then the controller is shown
    // the SAME component stream (setComponentState) so its display matches the DSP, and only
    // then its own private state. Doing it the other way round leaves an editor showing values
    // the processor does not have.
    MemoryStream componentStream(blob.component.data(), blob.component.size());
    StateCall call;
    call.kind = StateCall::Kind::componentSet;
    call.component = component_.get();
    call.stream = &componentStream;
    if (!runStateCall(&call, error)) return false;

    if (call.result != Steinberg::kResultOk && active_.load(std::memory_order_acquire)) {
        // The ABI allows setState while activated, but plenty of plugins only accept a full
        // state when they are not. The caller has already parked audio, so cycling here is safe;
        // the setup (sample rate, block size, buses) survives a deactivate/activate pair.
        const bool wasProcessing = processingOn_.load(std::memory_order_acquire);
        if (wasProcessing) processor_->setProcessing(false);
        component_->setActive(false);
        componentStream.rewind();
        const bool completed = runStateCall(&call, error);
        component_->setActive(true);
        if (wasProcessing) processor_->setProcessing(true);
        if (!completed) return false;
    }
    if (call.result != Steinberg::kResultOk) {
        error = "the plugin rejected this component state (it is probably from another plugin)";
        return false;
    }

    if (controller_) {
        componentStream.rewind();
        StateCall sync;
        sync.kind = StateCall::Kind::controllerComponentSet;
        sync.controller = controller_.get();
        sync.stream = &componentStream;
        std::string controllerError;
        runStateCall(&sync, controllerError);

        if (blob.hasController && !blob.controller.empty() && !stateFaulted_) {
            MemoryStream controllerStream(blob.controller.data(), blob.controller.size());
            StateCall privateState;
            privateState.kind = StateCall::Kind::controllerSet;
            privateState.controller = controller_.get();
            privateState.stream = &controllerStream;
            runStateCall(&privateState, controllerError);
        }
        if (stateFaulted_) {
            // The processor took the state but the controller did not survive it. The instance
            // is no longer trustworthy, so say so rather than report a half-applied success.
            error = controllerError;
            return false;
        }
        refreshParameterCache();
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

bool Vst3Instance::openEditor(std::uint64_t parentHwnd, int x, int y, int w, int h,
                              const std::string& title, std::string& error) {
    if (!controller_) {
        error = "this plugin has no edit controller, so there is no editor to open";
        return false;
    }
    return editor_.open(controller_.get(), parentHwnd, x, y, w, h,
                        title.empty() ? info_.name : title, error);
}

void Vst3Instance::setEditorRect(int x, int y, int w, int h) { editor_.setRect(x, y, w, h); }

void Vst3Instance::closeEditor() { editor_.close(); }

void Vst3Instance::editorResized(int width, int height) {
    if (events_ != nullptr) events_->onEditorResized(width, height);
}

void Vst3Instance::editorClosedByUser() {
    // Called from inside the window procedure with the plugin still on the stack; finish on our
    // own turn of the message loop.
    editorCloseRequested_.store(true, std::memory_order_release);
    requestMessageThreadHop();
}

// ---------------------------------------------------------------------------------------------
// Audio thread
// ---------------------------------------------------------------------------------------------

void Vst3Instance::process(const float* const* in, float* const* out, std::int32_t frames,
                           const TransportInfo& transport) {
    if (frames <= 0) return;
    if (!processingOn_.load(std::memory_order_acquire) || outputBusBuffers_.empty()) {
        // Not processing: hand back silence rather than whatever was in the caller's buffers.
        for (std::int32_t ch = 0; ch < channelsOut_; ++ch) {
            if (out != nullptr && out[ch] != nullptr) {
                std::memset(out[ch], 0, sizeof(float) * static_cast<std::size_t>(frames));
            }
        }
        return;
    }
    if (frames > config_.maxBlockSize) frames = config_.maxBlockSize;

    // Point the main buses at the caller's buffers. Everything else already points at the
    // silence buffer or at our scratch space and never moves.
    if (!inputChannelPointers_.empty()) {
        auto& mainIn = inputChannelPointers_.front();
        for (std::size_t ch = 0; ch < mainIn.size(); ++ch) {
            const float* source = (in != nullptr && static_cast<std::int32_t>(ch) < channelsIn_)
                                      ? in[ch]
                                      : nullptr;
            // const_cast is forced by the ABI: AudioBusBuffers has no const flavour. The plugin
            // is contractually forbidden from writing to its inputs, and in and out never alias.
            mainIn[ch] = source != nullptr ? const_cast<float*>(source) : silenceBuffer_.data();
        }
    }
    {
        auto& mainOut = outputChannelPointers_.front();
        for (std::size_t ch = 0; ch < mainOut.size(); ++ch) {
            float* destination = (out != nullptr && static_cast<std::int32_t>(ch) < channelsOut_)
                                     ? out[ch]
                                     : nullptr;
            // Never the silence buffer: a plugin WRITES here, and the inputs of every inactive
            // bus read that buffer as silence (JUCE's buffer mapper gives each its own backing).
            mainOut[ch] = destination != nullptr ? destination : discardBuffer_.data();
        }
        outputBusBuffers_.front().silenceFlags = 0;
    }

    // Drain the pending edits into this block's input parameter changes. Sample offset 0: the
    // engine sends a value for "now", not an automation curve.
    drainEditsIntoInputChanges();
    outputChanges_.clear();

    // Filled the way JUCE's VST3 host fills it (toProcessContext): the whole struct is zeroed
    // every block and only what the host really knows is flagged valid.
    //  - NO continuous-time claim. This host used to copy the project position into
    //    continousTimeSamples and flag it valid, so a counter plugins treat as monotonic jumped
    //    backwards on every seek and loop wrap. JUCE leaves it unset; so do we.
    //  - Time signature and the last bar start go with the musical position. theDAW has one
    //    tempo and one meter (4/4) for the whole project, so both follow from the tempo; without
    //    them a tempo-synced plugin (delay, arpeggiator, LFO) cannot find the bar.
    processContext_ = Steinberg::Vst::ProcessContext{};
    processContext_.sampleRate = config_.sampleRate;
    processContext_.projectTimeSamples =
        static_cast<Steinberg::Vst::TSamples>(transport.positionSamples);
    if (transport.playing) processContext_.state |= Steinberg::Vst::ProcessContext::kPlaying;
    if (transport.tempoBpm > 0.0) {
        processContext_.tempo = transport.tempoBpm;
        processContext_.state |= Steinberg::Vst::ProcessContext::kTempoValid;
        // Only claim a musical position when there is a tempo to derive it from; a made-up
        // projectTimeMusic makes tempo-synced plugins drift.
        if (config_.sampleRate > 0.0) {
            const double ppq =
                (transport.positionSamples / config_.sampleRate) * (transport.tempoBpm / 60.0);
            processContext_.projectTimeMusic = ppq;
            processContext_.state |= Steinberg::Vst::ProcessContext::kProjectTimeMusicValid;
            constexpr double kQuartersPerBar = 4.0;  // 4/4
            processContext_.timeSigNumerator = 4;
            processContext_.timeSigDenominator = 4;
            processContext_.state |= Steinberg::Vst::ProcessContext::kTimeSigValid;
            processContext_.barPositionMusic = std::floor(ppq / kQuartersPerBar) * kQuartersPerBar;
            processContext_.state |= Steinberg::Vst::ProcessContext::kBarPositionValid;
        }
    }

    // This block's MIDI: notes into the event list, controllers and the wheel onto their mapped
    // parameters at their own offsets. After the context above, which dates each note.
    fillBlockMidi();
    outputEvents_.clear();

    processData_.numSamples = frames;
    processor_->process(processData_);

    // A plugin may declare an output channel silent and leave the buffer untouched; the caller
    // would then play whatever was there before.
    const Steinberg::uint64 silence = outputBusBuffers_.front().silenceFlags;
    if (silence != 0 && out != nullptr) {
        for (std::int32_t ch = 0; ch < channelsOut_ && ch < 64; ++ch) {
            if (((silence >> ch) & 1u) != 0 && out[ch] != nullptr) {
                std::memset(out[ch], 0, sizeof(float) * static_cast<std::size_t>(frames));
            }
        }
    }

    // Forward anything the plugin wrote back out as automation. Only the final value of each
    // parameter matters to a controller that is not recording.
    forwardOutputChanges();
}

bool Vst3Instance::drainEditsIntoInputChanges() {
    inputChanges_.clear();
    bool any = false;
    ParamEdit edit;
    while (toProcessor_.pop(edit)) {
        if (ParamValueQueue* queue = inputChanges_.queueFor(edit.id)) {
            queue->setSinglePoint(0, edit.value);
            any = true;
        } else {
            break;  // block is full; the rest ride the next one
        }
    }
    return any;
}

void Vst3Instance::forwardOutputChanges() {
    bool anyOutput = false;
    for (std::size_t i = 0; i < outputChanges_.usedCount(); ++i) {
        ParamValueQueue* queue = outputChanges_.at(i);
        if (queue == nullptr) continue;
        double value = 0.0;
        if (!queue->lastValue(value)) continue;
        ParamEdit outgoing;
        outgoing.id = queue->getParameterId();
        outgoing.value = value;
        if (toMessageThread_.push(outgoing)) anyOutput = true;
    }
    if (anyOutput) {
        // One PostMessage at most per batch, and only when there is something to collect.
        requestMessageThreadHop();
    }
}

void Vst3Instance::flushParameters() {
    if (!processingOn_.load(std::memory_order_acquire) || !processor_) return;
    // Nothing queued: do not bother the plugin. This is the common case — the engine only calls
    // us when a set_param went by, and one call clears the whole queue.
    if (!drainEditsIntoInputChanges()) return;
    outputChanges_.clear();
    inputEvents_.clear();
    outputEvents_.clear();

    // Everything flushData_ points at was allocated in allocateProcessBuffers(); the only field
    // that moves is numSamples, which stays 0 for the lifetime of the call.
    flushData_.numSamples = 0;
    processor_->process(flushData_);

    forwardOutputChanges();
}

void Vst3Instance::setBlockMidi(const MidiEvent* events, std::int32_t count) {
    blockMidi_ = events;
    blockMidiCount_ = events != nullptr ? std::max<std::int32_t>(0, count) : 0;
}

void Vst3Instance::buildMidiMapping() {
    midiParam_.assign(static_cast<std::size_t>(16 * kMidiControllerSlots), kNoMidiParam);
    if (!controller_) return;
    Steinberg::Vst::IMidiMapping* mapping = nullptr;
    if (controller_->queryInterface(Steinberg::Vst::IMidiMapping::iid,
                                    reinterpret_cast<void**>(&mapping)) != Steinberg::kResultOk ||
        mapping == nullptr) {
        return;
    }
    for (Steinberg::int16 channel = 0; channel < 16; ++channel) {
        for (Steinberg::int16 controller = 0; controller < kMidiControllerSlots; ++controller) {
            Steinberg::Vst::ParamID id = 0;
            if (mapping->getMidiControllerAssignment(0, channel, controller, id) == Steinberg::kResultOk) {
                midiParam_[static_cast<std::size_t>(channel * kMidiControllerSlots + controller)] =
                    static_cast<std::int64_t>(id);
            }
        }
    }
    mapping->release();
}

void Vst3Instance::fillBlockMidi() {
    inputEvents_.clear();
    const MidiEvent* events = blockMidi_;
    const std::int32_t count = blockMidiCount_;
    blockMidi_ = nullptr;
    blockMidiCount_ = 0;
    if (events == nullptr || count <= 0) return;
    const bool tempoValid = (processContext_.state & Steinberg::Vst::ProcessContext::kTempoValid) != 0;
    const double ppqPerSample =
        tempoValid && config_.sampleRate > 0 ? processContext_.tempo / 60.0 / config_.sampleRate : 0.0;

    auto mapped = [&](std::int32_t channel, std::int32_t controller, std::int32_t offset, double value) {
        if (midiParam_.empty() || controller < 0 || controller >= kMidiControllerSlots) return;
        const std::int64_t id =
            midiParam_[static_cast<std::size_t>(channel * kMidiControllerSlots + controller)];
        if (id == kNoMidiParam) return;
        if (ParamValueQueue* queue = inputChanges_.queueFor(static_cast<Steinberg::Vst::ParamID>(id))) {
            Steinberg::int32 index = 0;
            queue->addPoint(offset, value, index);
        }
    };

    for (std::int32_t i = 0; i < count; ++i) {
        const MidiEvent& m = events[i];
        if (m.size < 2) continue;
        const std::int32_t offset = std::max<std::int32_t>(0, m.sampleOffset);
        const std::uint8_t kind = static_cast<std::uint8_t>(m.data[0] & 0xF0);
        const Steinberg::int16 channel = static_cast<Steinberg::int16>(m.data[0] & 0x0F);
        Steinberg::Vst::Event e{};
        e.busIndex = 0;
        e.sampleOffset = offset;
        e.ppqPosition = processContext_.projectTimeMusic + static_cast<double>(offset) * ppqPerSample;
        e.flags = 0;
        switch (kind) {
            case 0x90:
                if (m.size < 3) break;
                if (m.data[2] > 0) {
                    e.type = Steinberg::Vst::Event::kNoteOnEvent;
                    e.noteOn.channel = channel;
                    e.noteOn.pitch = static_cast<Steinberg::int16>(m.data[1]);
                    e.noteOn.tuning = 0.0f;
                    e.noteOn.velocity = static_cast<float>(m.data[2]) / 127.0f;
                    e.noteOn.length = 0;
                    e.noteOn.noteId = -1;
                } else {
                    e.type = Steinberg::Vst::Event::kNoteOffEvent;
                    e.noteOff.channel = channel;
                    e.noteOff.pitch = static_cast<Steinberg::int16>(m.data[1]);
                    e.noteOff.velocity = 0.0f;
                    e.noteOff.noteId = -1;
                    e.noteOff.tuning = 0.0f;
                }
                inputEvents_.push(e);
                break;
            case 0x80:
                if (m.size < 3) break;
                e.type = Steinberg::Vst::Event::kNoteOffEvent;
                e.noteOff.channel = channel;
                e.noteOff.pitch = static_cast<Steinberg::int16>(m.data[1]);
                e.noteOff.velocity = static_cast<float>(m.data[2]) / 127.0f;
                e.noteOff.noteId = -1;
                e.noteOff.tuning = 0.0f;
                inputEvents_.push(e);
                break;
            case 0xA0:
                if (m.size < 3) break;
                e.type = Steinberg::Vst::Event::kPolyPressureEvent;
                e.polyPressure.channel = channel;
                e.polyPressure.pitch = static_cast<Steinberg::int16>(m.data[1]);
                e.polyPressure.pressure = static_cast<float>(m.data[2]) / 127.0f;
                e.polyPressure.noteId = -1;
                inputEvents_.push(e);
                break;
            case 0xB0:
                if (m.size < 3) break;
                mapped(channel, m.data[1], offset, static_cast<double>(m.data[2]) / 127.0);
                break;
            case 0xD0:
                mapped(channel, Steinberg::Vst::kAfterTouch, offset, static_cast<double>(m.data[1]) / 127.0);
                break;
            case 0xE0: {
                if (m.size < 3) break;
                const int raw = static_cast<int>(m.data[1]) | (static_cast<int>(m.data[2]) << 7);
                mapped(channel, Steinberg::Vst::kPitchBend, offset, static_cast<double>(raw) / 16383.0);
                break;
            }
            default:
                // Program changes: a VST3 instrument plays the preset dialled into it.
                break;
        }
    }
}

void Vst3Instance::resetDsp() {
    // Deliberately nothing. The engine calls this on the AUDIO thread for every start, seek and
    // loop wrap, and it used to cycle setProcessing(false/true) right here. JUCE's VST3 host
    // never does that: its reset() is an explicit message-thread operation (setProcessing and
    // setActive cycled under the process lock), and a transport jump is not one — the plugin
    // learns about the jump from the process context, and its tails ring across a loop point
    // exactly as they do in REAPER. Cycling from the audio thread was a realtime hazard too:
    // plenty of plugins allocate and free inside setProcessing.
}

}  // namespace thedaw::vst3
