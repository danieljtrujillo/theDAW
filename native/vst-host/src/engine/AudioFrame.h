// The binary audio frame from docs/design/vst-live-protocol.md.
//
//   off  size  field
//   0    u32   magic 0x4C545356 ("VSTL")
//   4    u8    type  0 = audio_in, 1 = audio_out
//   5    u8    channels (1..8)
//   6    u16   flags  bit0 playing, bit1 discontinuity
//   8    u32   seq
//   12   u32   frames per channel
//   16   f64   position_samples
//   24   f64   tempo_bpm
//   32   ...   float32 planar
//
// Little-endian on the wire; the host is Windows/x86-64 only, so the integer and
// float layouts match and the codec is byte-exact rather than byte-swapping.
#pragma once

#include <cstddef>
#include <cstdint>

namespace thedaw {

inline constexpr uint32_t kFrameMagic = 0x4C545356u;
inline constexpr uint8_t kFrameTypeAudioIn = 0;
inline constexpr uint8_t kFrameTypeAudioOut = 1;
inline constexpr size_t kAudioFrameHeaderSize = 32;
inline constexpr uint16_t kFlagPlaying = 1u << 0;
inline constexpr uint16_t kFlagDiscontinuity = 1u << 1;
inline constexpr int kMaxWireChannels = 8;

struct AudioFrameHeader {
    uint32_t magic = kFrameMagic;
    uint8_t type = kFrameTypeAudioIn;
    uint8_t channels = 0;
    uint16_t flags = 0;
    uint32_t seq = 0;
    uint32_t frames = 0;
    double positionSamples = 0.0;
    double tempoBpm = 0.0;
};

// False when `size` is below the 32-byte header.
bool readAudioFrameHeader(const uint8_t* data, size_t size, AudioFrameHeader& out);

// Writes exactly kAudioFrameHeaderSize bytes.
void writeAudioFrameHeader(uint8_t* out, const AudioFrameHeader& header);

}  // namespace thedaw
