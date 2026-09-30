// Preallocated multi-channel delay used by soft bypass: the dry signal has to
// come out aligned with the plugin's latency, otherwise toggling bypass jumps
// the signal forward by latencySamples.
#pragma once

#include <algorithm>
#include <cstring>
#include <vector>

namespace thedaw {

class DelayLine {
public:
    // Allocates once. Never called while the audio thread is running.
    void prepare(int channels, int maxDelay, int maxBlock) {
        channels_ = std::max(channels, 1);
        maxDelay_ = std::max(maxDelay, 0);
        capacity_ = static_cast<size_t>(maxDelay_) + static_cast<size_t>(std::max(maxBlock, 1)) + 1;
        storage_.assign(static_cast<size_t>(channels_) * capacity_, 0.0f);
        writePos_ = 0;
        delay_ = std::min(delay_, maxDelay_);
    }

    int maxDelay() const { return maxDelay_; }
    int delay() const { return delay_; }

    // Returns false when `samples` does not fit; the caller must re-prepare.
    bool setDelay(int samples) {
        if (samples < 0 || samples > maxDelay_) return false;
        if (samples != delay_) {
            delay_ = samples;
            clear();
        }
        return true;
    }

    void clear() {
        std::fill(storage_.begin(), storage_.end(), 0.0f);
        writePos_ = 0;
    }

    // AUDIO THREAD. Writes `frames` of `in` and reads the delayed signal into
    // `out`. `in` and `out` may be the same pointers.
    void process(const float* const* in, float* const* out, int channels, int frames) {
        if (storage_.empty() || frames <= 0) return;
        const int active = std::min(channels, channels_);
        size_t write = writePos_;
        const size_t delay = static_cast<size_t>(delay_);
        for (int i = 0; i < frames; ++i) {
            const size_t read = (write + capacity_ - delay) % capacity_;
            for (int ch = 0; ch < active; ++ch) {
                float* line = storage_.data() + static_cast<size_t>(ch) * capacity_;
                line[write] = in[ch][i];
                out[ch][i] = line[read];
            }
            write = (write + 1) % capacity_;
        }
        writePos_ = write;
    }

private:
    std::vector<float> storage_;
    size_t capacity_ = 0;
    size_t writePos_ = 0;
    int channels_ = 0;
    int maxDelay_ = 0;
    int delay_ = 0;
};

}  // namespace thedaw
