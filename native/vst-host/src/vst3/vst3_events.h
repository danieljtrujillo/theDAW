// Event lists for the process call.
//
// The input list carries the notes the client's `midi` op sends (docs/design/vst-live-protocol.md)
// for the block being processed: note-ons, note-offs and polyphonic pressure, each at its sample
// offset. Controllers, channel pressure and the pitch wheel are not events in VST3; the instance
// turns them into parameter changes through the plugin's IMidiMapping. A block with no MIDI hands
// the plugin a real, empty list (never a null pointer: an active event bus handed null makes some
// plugins reach for it anyway).
//
// The output list takes whatever a plugin writes and keeps it until the next block clears it;
// this host has nowhere to send a plugin's MIDI output, so it is never read.
//
// Fixed capacity, allocated before processing starts: filling and clearing are realtime-safe.
#pragma once

#include <cstddef>
#include <vector>

#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"

#include "vst3_common.h"

namespace thedaw::vst3 {

class EventList final : public Steinberg::Vst::IEventList, public HostObject {
public:
    // Message thread, before processing starts.
    void reserve(std::size_t capacity) {
        events_.assign(capacity < 1 ? 1 : capacity, Steinberg::Vst::Event{});
        count_ = 0;
    }
    // Audio thread.
    void clear() { count_ = 0; }
    std::size_t size() const { return count_; }
    // Audio thread. False when the block is full (the event is dropped rather than allocate).
    bool push(const Steinberg::Vst::Event& event) {
        if (count_ >= events_.size()) return false;
        events_[count_++] = event;
        return true;
    }

    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE {
        if (obj == nullptr) return Steinberg::kInvalidArgument;
        *obj = nullptr;
        THEDAW_VST3_OFFER(Steinberg::Vst::IEventList)
        THEDAW_VST3_OFFER(Steinberg::FUnknown)
        return Steinberg::kNoInterface;
    }
    THEDAW_VST3_REFCOUNT(HostObject)

    Steinberg::int32 PLUGIN_API getEventCount() SMTG_OVERRIDE {
        return static_cast<Steinberg::int32>(count_);
    }
    Steinberg::tresult PLUGIN_API getEvent(Steinberg::int32 index, Steinberg::Vst::Event& e) SMTG_OVERRIDE {
        if (index < 0 || static_cast<std::size_t>(index) >= count_) return Steinberg::kInvalidArgument;
        e = events_[static_cast<std::size_t>(index)];
        return Steinberg::kResultOk;
    }
    Steinberg::tresult PLUGIN_API addEvent(Steinberg::Vst::Event& e) SMTG_OVERRIDE {
        // A full output list keeps what it has and still answers ok: an error here makes plugins
        // log or retry, and nothing reads the output anyway.
        push(e);
        return Steinberg::kResultOk;
    }

private:
    std::vector<Steinberg::Vst::Event> events_;
    std::size_t count_ = 0;
};

}  // namespace thedaw::vst3
