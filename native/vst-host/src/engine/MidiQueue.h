// The live host's MIDI input: what the client's `midi` op sends, placed into audio blocks.
//
// The client (liveMixer, through the bridge) sends a track's notes, controllers and wheel ahead
// of time, each stamped with the timeline position it belongs to, in sample frames at the
// session's rate. The audio thread asks, once per block, for the messages that fall inside that
// block's [position, position + frames) and hands them to the plugin at their offsets, so a
// note lands on the sample the arrangement puts it on however early it arrived. A message
// whose position the block has already passed (a late send) plays at offset 0 of the next
// block; a position of -1 means "now" (a key played live).
//
// `midi_panic` (a stop, a seek, a loop wrap) drops everything still waiting and releases every
// note this queue let through and has not seen released, with the sustain pedal up, so nothing
// hangs across the jump.
//
// Thread rules: push()/pushPanic() run on the MESSAGE thread only (the one producer of the
// ring); collect() runs on the AUDIO thread only. Nothing here allocates after construction.
#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>

#include "../plugin/IPluginInstance.h"
#include "../util/SpscQueue.h"

namespace thedaw {

class MidiQueue {
public:
    // Messages waiting across blocks, and messages one block can carry.
    static constexpr int32_t kMaxPending = 8192;
    static constexpr int32_t kMaxPerBlock = 1024;

    // ---- message thread ----
    // False (and counted as dropped) when the message is malformed or the ring is full.
    bool push(double positionSamples, const uint8_t* data, int32_t size) {
        if (!valid(data, size)) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        Item item;
        item.kind = Item::Kind::Event;
        item.position = positionSamples;
        item.size = static_cast<uint8_t>(size);
        for (int32_t i = 0; i < size; ++i) item.data[static_cast<size_t>(i)] = data[i];
        if (!ring_.push(item)) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        return true;
    }

    bool pushPanic() {
        Item item;
        item.kind = Item::Kind::Panic;
        if (!ring_.push(item)) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        return true;
    }

    // A channel voice message of the right length, data bytes 7-bit. System messages are refused.
    static bool valid(const uint8_t* data, int32_t size) {
        if (data == nullptr || size < 1 || size > 3) return false;
        const uint8_t status = data[0];
        if (status < 0x80 || status >= 0xF0) return false;
        const uint8_t kind = status & 0xF0;
        const int32_t want = (kind == 0xC0 || kind == 0xD0) ? 2 : 3;
        if (size != want) return false;
        for (int32_t i = 1; i < size; ++i) {
            if (data[i] > 0x7F) return false;
        }
        return true;
    }

    // ---- audio thread ----
    // The messages of the block [blockPosition, blockPosition + frames), sorted by offset, into
    // `out`; returns how many. Messages past the block stay for a later one.
    int32_t collect(double blockPosition, int32_t frames, MidiEvent* out, int32_t capacity) {
        int32_t count = 0;
        Item item;
        while (ring_.pop(item)) {
            if (item.kind == Item::Kind::Panic) {
                pendingCount_ = 0;
                count = releaseHeld(out, count, capacity);
                continue;
            }
            if (pendingCount_ >= kMaxPending) {
                dropped_.fetch_add(1, std::memory_order_relaxed);
                continue;
            }
            pending_[static_cast<size_t>(pendingCount_++)] = item;
        }

        const double end = blockPosition + static_cast<double>(frames);
        int32_t kept = 0;
        for (int32_t i = 0; i < pendingCount_; ++i) {
            const Item& p = pending_[static_cast<size_t>(i)];
            const bool due = p.position < 0.0 || p.position < end;
            if (!due || count >= capacity) {
                pending_[static_cast<size_t>(kept++)] = p;
                continue;
            }
            MidiEvent ev;
            double offset = p.position < 0.0 ? 0.0 : p.position - blockPosition;
            if (offset < 0.0) offset = 0.0;
            if (frames > 0 && offset > static_cast<double>(frames - 1)) offset = static_cast<double>(frames - 1);
            ev.sampleOffset = static_cast<int32_t>(offset);
            ev.size = p.size;
            ev.data[0] = p.data[0];
            ev.data[1] = p.data[1];
            ev.data[2] = p.data[2];
            track(ev);
            out[count++] = ev;
        }
        pendingCount_ = kept;
        // Insertion sort by offset: stable, so messages at one sample keep the order they came in.
        for (int32_t i = 1; i < count; ++i) {
            const MidiEvent key = out[i];
            int32_t j = i - 1;
            while (j >= 0 && out[j].sampleOffset > key.sampleOffset) {
                out[j + 1] = out[j];
                --j;
            }
            out[j + 1] = key;
        }
        return count;
    }

    int32_t pendingCount() const { return pendingCount_; }
    uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

private:
    struct Item {
        enum class Kind : uint8_t { Event, Panic };
        Kind kind = Kind::Event;
        double position = 0.0;
        uint8_t data[3] = {0, 0, 0};
        uint8_t size = 0;
    };

    // Count the notes this queue lets through, so a panic knows what to release.
    void track(const MidiEvent& ev) {
        const uint8_t kind = ev.data[0] & 0xF0;
        const uint8_t channel = ev.data[0] & 0x0F;
        uint8_t& held = held_[channel][ev.data[1] & 0x7F];
        if (kind == 0x90 && ev.data[2] > 0) {
            if (held < 255) ++held;
        } else if (kind == 0x80 || (kind == 0x90 && ev.data[2] == 0)) {
            if (held > 0) --held;
        }
    }

    int32_t releaseHeld(MidiEvent* out, int32_t count, int32_t capacity) {
        for (uint8_t channel = 0; channel < 16; ++channel) {
            bool any = false;
            for (uint8_t note = 0; note < 128; ++note) {
                uint8_t& held = held_[channel][note];
                while (held > 0 && count < capacity) {
                    MidiEvent off;
                    off.size = 3;
                    off.data[0] = static_cast<uint8_t>(0x80 | channel);
                    off.data[1] = note;
                    off.data[2] = 0;
                    out[count++] = off;
                    --held;
                    any = true;
                }
            }
            if (any && count < capacity) {
                MidiEvent pedal;  // sustain up, so a released note is not held by the pedal
                pedal.size = 3;
                pedal.data[0] = static_cast<uint8_t>(0xB0 | channel);
                pedal.data[1] = 64;
                pedal.data[2] = 0;
                out[count++] = pedal;
            }
        }
        return count;
    }

    util::SpscQueue<Item, 8192> ring_;
    std::array<Item, kMaxPending> pending_{};
    int32_t pendingCount_ = 0;
    uint8_t held_[16][128] = {};
    std::atomic<uint64_t> dropped_{0};
};

}  // namespace thedaw
