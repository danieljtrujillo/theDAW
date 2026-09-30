#include "AudioFrame.h"

#include <cstring>

namespace thedaw {
namespace {

uint16_t readU16(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (static_cast<uint16_t>(p[1]) << 8));
}

uint32_t readU32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

double readF64(const uint8_t* p) {
    double value = 0;
    std::memcpy(&value, p, sizeof(value));
    return value;
}

void writeU16(uint8_t* p, uint16_t value) {
    p[0] = static_cast<uint8_t>(value & 0xFFu);
    p[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
}

void writeU32(uint8_t* p, uint32_t value) {
    p[0] = static_cast<uint8_t>(value & 0xFFu);
    p[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
    p[2] = static_cast<uint8_t>((value >> 16) & 0xFFu);
    p[3] = static_cast<uint8_t>((value >> 24) & 0xFFu);
}

void writeF64(uint8_t* p, double value) { std::memcpy(p, &value, sizeof(value)); }

}  // namespace

bool readAudioFrameHeader(const uint8_t* data, size_t size, AudioFrameHeader& out) {
    if (data == nullptr || size < kAudioFrameHeaderSize) return false;
    out.magic = readU32(data);
    out.type = data[4];
    out.channels = data[5];
    out.flags = readU16(data + 6);
    out.seq = readU32(data + 8);
    out.frames = readU32(data + 12);
    out.positionSamples = readF64(data + 16);
    out.tempoBpm = readF64(data + 24);
    return true;
}

void writeAudioFrameHeader(uint8_t* out, const AudioFrameHeader& header) {
    writeU32(out, header.magic);
    out[4] = header.type;
    out[5] = header.channels;
    writeU16(out + 6, header.flags);
    writeU32(out + 8, header.seq);
    writeU32(out + 12, header.frames);
    writeF64(out + 16, header.positionSamples);
    writeF64(out + 24, header.tempoBpm);
}

}  // namespace thedaw
