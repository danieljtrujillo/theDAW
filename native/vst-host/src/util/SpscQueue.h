// Single-producer / single-consumer ring with in-place slots.
//
// The audio thread is always one of the two ends, so neither side may allocate,
// lock or block. Slot objects are constructed once when the queue is built and
// reused forever; the producer may grow a slot (for example a std::string
// payload) because only the producer ever writes to it.
#pragma once

#include <atomic>
#include <cstddef>

namespace thedaw::util {

template <typename T, size_t Capacity>
class SpscQueue {
    static_assert(Capacity >= 2, "capacity must be at least 2");
    static_assert((Capacity & (Capacity - 1)) == 0, "capacity must be a power of two");

public:
    SpscQueue() = default;
    SpscQueue(const SpscQueue&) = delete;
    SpscQueue& operator=(const SpscQueue&) = delete;

    static constexpr size_t capacity() { return Capacity; }

    // ---- producer side ----
    // Returns the slot that commitWrite() will publish, or nullptr when full.
    T* writeSlot() {
        const size_t write = writeIndex_.load(std::memory_order_relaxed);
        const size_t read = readIndex_.load(std::memory_order_acquire);
        if (write - read >= Capacity) return nullptr;
        return &slots_[write & (Capacity - 1)];
    }

    void commitWrite() {
        writeIndex_.store(writeIndex_.load(std::memory_order_relaxed) + 1,
                          std::memory_order_release);
    }

    bool push(const T& value) {
        T* slot = writeSlot();
        if (slot == nullptr) return false;
        *slot = value;
        commitWrite();
        return true;
    }

    // ---- consumer side ----
    // Returns the oldest unread slot, or nullptr when empty. The slot stays
    // valid until commitRead().
    T* readSlot() {
        const size_t read = readIndex_.load(std::memory_order_relaxed);
        const size_t write = writeIndex_.load(std::memory_order_acquire);
        if (read == write) return nullptr;
        return &slots_[read & (Capacity - 1)];
    }

    void commitRead() {
        readIndex_.store(readIndex_.load(std::memory_order_relaxed) + 1,
                         std::memory_order_release);
    }

    bool pop(T& out) {
        T* slot = readSlot();
        if (slot == nullptr) return false;
        out = *slot;
        commitRead();
        return true;
    }

    // Setup only: visits every slot so the caller can reserve capacity inside
    // it. Must not be called once either end is live.
    template <typename Fn>
    void forEachSlot(Fn&& fn) {
        for (size_t i = 0; i < Capacity; ++i) fn(slots_[i]);
    }

    // ---- observers (approximate when called from the opposite side) ----
    size_t size() const {
        return writeIndex_.load(std::memory_order_acquire) -
               readIndex_.load(std::memory_order_acquire);
    }

    bool empty() const { return size() == 0; }

private:
    std::atomic<size_t> writeIndex_{0};
    std::atomic<size_t> readIndex_{0};
    T slots_[Capacity];
};

}  // namespace thedaw::util
