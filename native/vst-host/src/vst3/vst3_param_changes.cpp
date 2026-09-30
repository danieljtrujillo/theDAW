#include "vst3_param_changes.h"

#include <memory>

namespace thedaw::vst3 {
namespace {

std::size_t roundUpToPowerOfTwo(std::size_t n) {
    std::size_t p = 1;
    while (p < n) p <<= 1;
    return p;
}

}  // namespace

// ------------------------------------------------------------------------------------------
// EditRing
// ------------------------------------------------------------------------------------------

EditRing::EditRing(std::size_t capacityPowerOfTwo)
    : slots_(roundUpToPowerOfTwo(capacityPowerOfTwo < 2 ? 2 : capacityPowerOfTwo)) {
    mask_ = slots_.size() - 1;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
        slots_[i].sequence.store(i, std::memory_order_relaxed);
    }
}

bool EditRing::push(const ParamEdit& edit) {
    std::uint64_t pos = writeIndex_.load(std::memory_order_relaxed);
    for (;;) {
        Slot& slot = slots_[static_cast<std::size_t>(pos) & mask_];
        const std::uint64_t seq = slot.sequence.load(std::memory_order_acquire);
        const std::int64_t diff = static_cast<std::int64_t>(seq) - static_cast<std::int64_t>(pos);
        if (diff == 0) {
            if (writeIndex_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) {
                slot.edit = edit;
                slot.sequence.store(pos + 1, std::memory_order_release);
                return true;
            }
            // Lost the race; `pos` now holds the current head, retry from there.
        } else if (diff < 0) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;  // full
        } else {
            pos = writeIndex_.load(std::memory_order_relaxed);
        }
    }
}

bool EditRing::pop(ParamEdit& out) {
    const std::uint64_t pos = readIndex_.load(std::memory_order_relaxed);
    Slot& slot = slots_[static_cast<std::size_t>(pos) & mask_];
    const std::uint64_t seq = slot.sequence.load(std::memory_order_acquire);
    if (static_cast<std::int64_t>(seq) - static_cast<std::int64_t>(pos + 1) != 0) return false;
    out = slot.edit;
    readIndex_.store(pos + 1, std::memory_order_relaxed);
    slot.sequence.store(pos + mask_ + 1, std::memory_order_release);
    return true;
}

// ------------------------------------------------------------------------------------------
// ParamValueQueue
// ------------------------------------------------------------------------------------------

void ParamValueQueue::reservePoints(std::size_t count) {
    points_.assign(count < 1 ? 1 : count, Point{});
    count_ = 0;
}

void ParamValueQueue::reset(Steinberg::Vst::ParamID id) {
    id_ = id;
    count_ = 0;
}

void ParamValueQueue::setSinglePoint(Steinberg::int32 sampleOffset, double value) {
    if (points_.empty()) return;
    points_[0].sampleOffset = sampleOffset;
    points_[0].value = value;
    count_ = 1;
}

bool ParamValueQueue::lastValue(double& value) const {
    if (count_ == 0) return false;
    value = points_[count_ - 1].value;
    return true;
}

Steinberg::tresult PLUGIN_API ParamValueQueue::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::Vst::IParamValueQueue)
    THEDAW_VST3_OFFER(Steinberg::FUnknown)
    return Steinberg::kNoInterface;
}

Steinberg::tresult PLUGIN_API ParamValueQueue::getPoint(Steinberg::int32 index,
                                                        Steinberg::int32& sampleOffset,
                                                        Steinberg::Vst::ParamValue& value) {
    if (index < 0 || static_cast<std::size_t>(index) >= count_) return Steinberg::kResultFalse;
    const Point& point = points_[static_cast<std::size_t>(index)];
    sampleOffset = point.sampleOffset;
    value = point.value;
    return Steinberg::kResultOk;
}

Steinberg::tresult PLUGIN_API ParamValueQueue::addPoint(Steinberg::int32 sampleOffset,
                                                        Steinberg::Vst::ParamValue value,
                                                        Steinberg::int32& index) {
    if (points_.empty()) return Steinberg::kResultFalse;
    if (count_ < points_.size()) {
        points_[count_].sampleOffset = sampleOffset;
        points_[count_].value = value;
        index = static_cast<Steinberg::int32>(count_);
        ++count_;
    } else {
        // A plugin that writes more automation points in one block than we budgeted for keeps
        // its newest value: overwriting the tail preserves the parameter's final position,
        // which is all the controller needs. Growing here would allocate on the audio thread.
        points_.back().sampleOffset = sampleOffset;
        points_.back().value = value;
        index = static_cast<Steinberg::int32>(count_ - 1);
    }
    return Steinberg::kResultOk;
}

// ------------------------------------------------------------------------------------------
// ParameterChanges
// ------------------------------------------------------------------------------------------

void ParameterChanges::reserve(std::size_t maxQueues, std::size_t pointsPerQueue) {
    queues_.clear();
    queues_.reserve(maxQueues);
    for (std::size_t i = 0; i < maxQueues; ++i) {
        auto queue = std::make_unique<ParamValueQueue>();
        queue->reservePoints(pointsPerQueue);
        queues_.push_back(std::move(queue));
    }
    used_ = 0;
}

ParamValueQueue* ParameterChanges::queueFor(Steinberg::Vst::ParamID id) {
    for (std::size_t i = 0; i < used_; ++i) {
        if (queues_[i]->getParameterId() == id) return queues_[i].get();
    }
    if (used_ >= queues_.size()) return nullptr;
    ParamValueQueue* queue = queues_[used_].get();
    queue->reset(id);
    ++used_;
    return queue;
}

Steinberg::tresult PLUGIN_API ParameterChanges::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::Vst::IParameterChanges)
    THEDAW_VST3_OFFER(Steinberg::FUnknown)
    return Steinberg::kNoInterface;
}

Steinberg::Vst::IParamValueQueue* PLUGIN_API ParameterChanges::getParameterData(Steinberg::int32 index) {
    if (index < 0 || static_cast<std::size_t>(index) >= used_) return nullptr;
    return queues_[static_cast<std::size_t>(index)].get();
}

Steinberg::Vst::IParamValueQueue* PLUGIN_API ParameterChanges::addParameterData(
    const Steinberg::Vst::ParamID& id, Steinberg::int32& index) {
    for (std::size_t i = 0; i < used_; ++i) {
        if (queues_[i]->getParameterId() == id) {
            index = static_cast<Steinberg::int32>(i);
            return queues_[i].get();
        }
    }
    if (used_ >= queues_.size()) {
        index = 0;
        return nullptr;
    }
    ParamValueQueue* queue = queues_[used_].get();
    queue->reset(id);
    index = static_cast<Steinberg::int32>(used_);
    ++used_;
    return queue;
}

}  // namespace thedaw::vst3
