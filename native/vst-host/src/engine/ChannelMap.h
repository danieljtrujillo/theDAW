// Wire <-> plugin channel mapping.
//
// docs/design/vst-live-protocol.md: "falling back to stereo with up/down-mix
// (mono -> dup, stereo -> mono average)". Both of those are bit-exact for a
// passthrough plugin: duplicating then averaging gives (x + x) * 0.5 == x in
// IEEE-754, which is what keeps the null-plugin round trip exact.
#pragma once

#include <algorithm>

namespace thedaw {

// AUDIO THREAD. Copies `frames` from `srcChannels` planes to `dstChannels`.
inline void mapChannels(const float* const* src, int srcChannels, float* const* dst,
                        int dstChannels, int frames) {
    if (srcChannels <= 0 || dstChannels <= 0 || frames <= 0) return;

    if (srcChannels == dstChannels) {
        for (int ch = 0; ch < dstChannels; ++ch) {
            std::copy(src[ch], src[ch] + frames, dst[ch]);
        }
        return;
    }
    if (srcChannels == 1) {  // mono -> dup to every destination channel
        for (int ch = 0; ch < dstChannels; ++ch) {
            std::copy(src[0], src[0] + frames, dst[ch]);
        }
        return;
    }
    if (srcChannels == 2 && dstChannels == 1) {  // stereo -> mono average
        for (int i = 0; i < frames; ++i) {
            dst[0][i] = (src[0][i] + src[1][i]) * 0.5f;
        }
        return;
    }
    // Wider mismatches: take the leading channels, and repeat the last source
    // channel when the destination is wider.
    for (int ch = 0; ch < dstChannels; ++ch) {
        const int source = std::min(ch, srcChannels - 1);
        std::copy(src[source], src[source] + frames, dst[ch]);
    }
}

}  // namespace thedaw
