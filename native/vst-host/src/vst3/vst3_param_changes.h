// Parameter transport between threads, and the IParameterChanges / IParamValueQueue objects the
// plugin sees inside process().
//
// Two directions, both lock-free and both preallocated, because process() runs on the realtime
// thread and must not allocate, lock or log:
//
//   engine / editor  --EditRing-->  InputParameterChanges   (ProcessData::inputParameterChanges)
//   plugin           --OutputParameterChanges-->  EditRing  --> message thread --> controller
//
// The ring is a bounded multi-producer / single-consumer queue: `setParamNormalized` may be
// called from the socket thread and from the message thread (an editor edit has to reach the
// processor too), while only the audio thread drains it.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "pluginterfaces/vst/ivstparameterchanges.h"

#include "vst3_common.h"

namespace thedaw::vst3 {

struct ParamEdit {
    Steinberg::Vst::ParamID id = 0;
    double value = 0.0;  // normalized 0..1
    // The HOST set this value (a set_param from the app). It still has to reach the controller so
    // an open editor follows, but it is not news to the app and must not be reported back to it:
    // an echo of its own edit arrives late, and a slider being dragged jumps back to it.
    bool fromHost = false;
};

// Bounded MPSC ring. Producers claim a slot with a compare-exchange on the write index and
// publish it by bumping that slot's sequence; the consumer only reads a slot whose sequence says
// it is published. No producer ever waits for another producer, so a stalled thread cannot stall
// the audio thread — it can only make the queue look momentarily full, and a dropped parameter
// edit is recoverable (the next edit of that parameter carries the current value anyway).
class EditRing {
public:
    explicit EditRing(std::size_t capacityPowerOfTwo);

    // Any thread. False when the ring is full (the edit is dropped, deliberately).
    bool push(const ParamEdit& edit);
    // Single consumer only.
    bool pop(ParamEdit& out);

    std::uint64_t droppedCount() const { return dropped_.load(std::memory_order_relaxed); }

private:
    struct Slot {
        std::atomic<std::uint64_t> sequence{0};
        ParamEdit edit;
    };

    // The producers' fields, the consumer's field and the fields no thread writes after
    // construction each sit a full cache line of padding away from the next group, so a push
    // never invalidates the line the audio thread's pop reads, nor the reverse. Explicit padding
    // does this at whatever address the ring is allocated: every field here is 8 bytes on an
    // 8-byte boundary, so two fields with 64 bytes between them can never share a 64-byte line.
    static constexpr std::size_t kCacheLine = 64;
    using Index = std::atomic<std::uint64_t>;

    // Written only by the constructor.
    std::vector<Slot> slots_;
    std::size_t mask_ = 0;
    char padAfterConstants_[kCacheLine]{};
    // Written by the producers.
    Index writeIndex_{0};
    Index dropped_{0};
    char padAfterProducers_[kCacheLine]{};
    // Written by the consumer.
    Index readIndex_{0};
    char padAfterConsumer_[kCacheLine]{};
};

// One parameter's points inside a block. Fixed capacity, filled either by us (input) or by the
// plugin (output).
class ParamValueQueue final : public Steinberg::Vst::IParamValueQueue, public HostObject {
public:
    void reservePoints(std::size_t count);
    void reset(Steinberg::Vst::ParamID id);
    // Realtime-safe: replaces any existing point at the same offset, never grows.
    void setSinglePoint(Steinberg::int32 sampleOffset, double value);
    bool lastValue(double& value) const;

    // ---- FUnknown ----
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HostObject)

    // ---- IParamValueQueue ----
    Steinberg::Vst::ParamID PLUGIN_API getParameterId() SMTG_OVERRIDE { return id_; }
    Steinberg::int32 PLUGIN_API getPointCount() SMTG_OVERRIDE {
        return static_cast<Steinberg::int32>(count_);
    }
    Steinberg::tresult PLUGIN_API getPoint(Steinberg::int32 index, Steinberg::int32& sampleOffset,
                                           Steinberg::Vst::ParamValue& value) SMTG_OVERRIDE;
    Steinberg::tresult PLUGIN_API addPoint(Steinberg::int32 sampleOffset,
                                           Steinberg::Vst::ParamValue value,
                                           Steinberg::int32& index) SMTG_OVERRIDE;

private:
    struct Point {
        Steinberg::int32 sampleOffset = 0;
        double value = 0.0;
    };

    Steinberg::Vst::ParamID id_ = 0;
    std::vector<Point> points_;
    std::size_t count_ = 0;
};

// A block's worth of parameter queues. Preallocated at prepare() time; `clear()` and the
// per-block filling are realtime-safe.
class ParameterChanges final : public Steinberg::Vst::IParameterChanges, public HostObject {
public:
    // `maxQueues` distinct parameters per block, `pointsPerQueue` points each.
    void reserve(std::size_t maxQueues, std::size_t pointsPerQueue);
    void clear() { used_ = 0; }
    // Realtime-safe. Returns nullptr when the block already holds `maxQueues` parameters.
    ParamValueQueue* queueFor(Steinberg::Vst::ParamID id);
    std::size_t usedCount() const { return used_; }
    ParamValueQueue* at(std::size_t index) { return index < used_ ? queues_[index].get() : nullptr; }

    // ---- FUnknown ----
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HostObject)

    // ---- IParameterChanges ----
    Steinberg::int32 PLUGIN_API getParameterCount() SMTG_OVERRIDE {
        return static_cast<Steinberg::int32>(used_);
    }
    Steinberg::Vst::IParamValueQueue* PLUGIN_API getParameterData(Steinberg::int32 index) SMTG_OVERRIDE;
    Steinberg::Vst::IParamValueQueue* PLUGIN_API addParameterData(
        const Steinberg::Vst::ParamID& id, Steinberg::int32& index) SMTG_OVERRIDE;

private:
    std::vector<std::unique_ptr<ParamValueQueue>> queues_;
    std::size_t used_ = 0;
};

}  // namespace thedaw::vst3
