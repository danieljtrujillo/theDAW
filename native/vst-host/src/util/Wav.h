// A RIFF/WAVE reader and writer, ours, with no dependency beyond the C++ standard library.
//
// Scope is deliberately exactly what offline rendering needs and nothing else:
//   read   PCM 16 / 24 / 32-bit integer and 32-bit IEEE float, mono..8 channels, including
//          WAVE_FORMAT_EXTENSIBLE wrapping either of those;
//   write  32-bit IEEE float, because a render is one stage of a chain and requantising at each
//          stage is how a mix loses its top end.
//
// Anything else — RF64, AIFF, a-law, ADPCM, 64-bit float, a WAVE with no data chunk — is refused
// by name so the caller can say what was wrong instead of producing silence.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace thedaw::util {

struct WavAudio {
    int channels = 0;
    double sampleRate = 0;
    // Planar float32: samples[ch] is `frames` long. Planar rather than interleaved because that
    // is what IAudioProcessor::process wants.
    std::vector<std::vector<float>> samples;
    // What the file said it was, for the render report: "pcm16", "pcm24", "pcm32", "float32".
    std::string sourceFormat;

    std::size_t frames() const { return samples.empty() ? 0 : samples.front().size(); }
};

// Parses a whole WAV held in memory. Returns false with a human-readable `error` for every
// rejection; never throws for malformed input.
bool parseWav(const std::uint8_t* data, std::size_t size, WavAudio& out, std::string& error);

// Serialises planar float32 channels as a 32-bit IEEE float WAV (fmt + fact + data).
// `channels` must be non-empty and all channels the same length.
bool buildFloatWav(const std::vector<std::vector<float>>& channels, double sampleRate,
                   std::vector<std::uint8_t>& out, std::string& error);

// Whole-file helpers. `path` is UTF-8; the Windows wide API is used underneath so a plugin in a
// folder with non-ASCII characters still renders.
bool readWavFile(const std::string& path, WavAudio& out, std::string& error);
bool writeWavFile(const std::string& path, const std::vector<std::vector<float>>& channels,
                  double sampleRate, std::string& error);

}  // namespace thedaw::util
