#include "Wav.h"

#include <cstdint>
#include <cstring>
#include <limits>

#include "AtomicFile.h"
#include "StringUtil.h"

namespace thedaw::util {
namespace {

constexpr std::uint16_t kFormatPcm = 0x0001;
constexpr std::uint16_t kFormatFloat = 0x0003;
constexpr std::uint16_t kFormatExtensible = 0xFFFE;

// WAVE files stay under 4 GiB by construction; this host refuses anything near that long before
// it can overflow a chunk size.
constexpr std::uint64_t kMaxDataBytes = 0xFFFF0000ull;
// The on-disk WAV (header + data) this host will read at all; readFileLimited enforces this
// before a single byte reaches parseWav.
constexpr std::uint64_t kMaxWavFileBytes = 1024ull * 1024ull * 1024ull;
constexpr int kMaxChannels = 8;

std::uint16_t readLe16(const std::uint8_t* p) {
    return static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[0]) |
                                      (static_cast<std::uint16_t>(p[1]) << 8));
}

std::uint32_t readLe32(const std::uint8_t* p) {
    return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

void appendLe16(std::vector<std::uint8_t>& out, std::uint16_t value) {
    out.push_back(static_cast<std::uint8_t>(value & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
}

void appendLe32(std::vector<std::uint8_t>& out, std::uint32_t value) {
    out.push_back(static_cast<std::uint8_t>(value & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFF));
}

void appendTag(std::vector<std::uint8_t>& out, const char tag[4]) {
    out.insert(out.end(), tag, tag + 4);
}

bool tagIs(const std::uint8_t* p, const char* tag) {
    return p[0] == static_cast<std::uint8_t>(tag[0]) && p[1] == static_cast<std::uint8_t>(tag[1]) &&
           p[2] == static_cast<std::uint8_t>(tag[2]) && p[3] == static_cast<std::uint8_t>(tag[3]);
}

std::string printableTag(const std::uint8_t* p) {
    std::string tag;
    for (int i = 0; i < 4; ++i) {
        const unsigned char c = p[i];
        tag.push_back(c >= 0x20 && c < 0x7F ? static_cast<char>(c) : '?');
    }
    return tag;
}

float fromPcm16(const std::uint8_t* p) {
    const std::int16_t value = static_cast<std::int16_t>(readLe16(p));
    return static_cast<float>(static_cast<double>(value) / 32768.0);
}

float fromPcm24(const std::uint8_t* p) {
    std::int32_t value = static_cast<std::int32_t>(static_cast<std::uint32_t>(p[0]) |
                                                   (static_cast<std::uint32_t>(p[1]) << 8) |
                                                   (static_cast<std::uint32_t>(p[2]) << 16));
    if ((value & 0x00800000) != 0) value |= static_cast<std::int32_t>(0xFF000000u);
    return static_cast<float>(static_cast<double>(value) / 8388608.0);
}

float fromPcm32(const std::uint8_t* p) {
    const std::int32_t value = static_cast<std::int32_t>(readLe32(p));
    return static_cast<float>(static_cast<double>(value) / 2147483648.0);
}

float fromFloat32(const std::uint8_t* p) {
    const std::uint32_t bits = readLe32(p);
    float value = 0.0f;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

void appendFloat32(std::vector<std::uint8_t>& out, float value) {
    std::uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    appendLe32(out, bits);
}

struct FormatChunk {
    std::uint16_t tag = 0;
    std::uint16_t channels = 0;
    std::uint32_t sampleRate = 0;
    std::uint16_t bitsPerSample = 0;
};

bool parseFormatChunk(const std::uint8_t* body, std::size_t size, FormatChunk& out,
                      std::string& error) {
    if (size < 16) {
        error = "the WAV's fmt chunk is " + toString(static_cast<long long>(size)) +
                " bytes; 16 is the minimum";
        return false;
    }
    out.tag = readLe16(body);
    out.channels = readLe16(body + 2);
    out.sampleRate = readLe32(body + 4);
    out.bitsPerSample = readLe16(body + 14);

    if (out.tag == kFormatExtensible) {
        if (size < 40) {
            error = "the WAV says WAVE_FORMAT_EXTENSIBLE but its fmt chunk is only " +
                    toString(static_cast<long long>(size)) + " bytes";
            return false;
        }
        // The real format is the first two bytes of the SubFormat GUID at offset 24.
        out.tag = readLe16(body + 24);
    }
    return true;
}

}  // namespace

bool parseWav(const std::uint8_t* data, std::size_t size, WavAudio& out, std::string& error) {
    out = WavAudio{};
    error.clear();
    if (data == nullptr || size < 12) {
        error = "the input file is too small to be a WAV (" + toString(static_cast<long long>(size)) +
                " bytes)";
        return false;
    }
    if (!tagIs(data, "RIFF")) {
        error = "the input file starts with \"" + printableTag(data) +
                "\", not \"RIFF\"; this host reads RIFF/WAVE only";
        return false;
    }
    if (!tagIs(data + 8, "WAVE")) {
        error = "the input file is a RIFF of type \"" + printableTag(data + 8) +
                "\", not \"WAVE\"";
        return false;
    }

    FormatChunk format;
    bool haveFormat = false;
    const std::uint8_t* audio = nullptr;
    std::uint64_t audioBytes = 0;
    bool haveData = false;

    std::size_t cursor = 12;
    while (cursor + 8 <= size) {
        const std::uint8_t* header = data + cursor;
        const std::uint32_t declared = readLe32(header + 4);
        const std::size_t bodyAt = cursor + 8;
        // A declared size longer than the file means a truncated or streamed file; take what is
        // really there rather than reading past the buffer.
        const std::uint64_t available = static_cast<std::uint64_t>(size - bodyAt);
        const std::uint64_t body = declared < available ? declared : available;

        if (tagIs(header, "fmt ")) {
            if (!parseFormatChunk(data + bodyAt, static_cast<std::size_t>(body), format, error)) {
                return false;
            }
            haveFormat = true;
        } else if (tagIs(header, "data")) {
            audio = data + bodyAt;
            audioBytes = body;
            haveData = true;
        }

        // Chunks are word-aligned: an odd body is followed by one pad byte.
        const std::uint64_t advance = body + (body & 1u);
        if (advance > static_cast<std::uint64_t>(size - bodyAt)) break;
        cursor = bodyAt + static_cast<std::size_t>(advance);
    }

    if (!haveFormat) {
        error = "the WAV has no fmt chunk";
        return false;
    }
    if (!haveData) {
        error = "the WAV has no data chunk";
        return false;
    }

    int bytesPerSample = 0;
    if (format.tag == kFormatPcm && format.bitsPerSample == 16) {
        bytesPerSample = 2;
        out.sourceFormat = "pcm16";
    } else if (format.tag == kFormatPcm && format.bitsPerSample == 24) {
        bytesPerSample = 3;
        out.sourceFormat = "pcm24";
    } else if (format.tag == kFormatPcm && format.bitsPerSample == 32) {
        bytesPerSample = 4;
        out.sourceFormat = "pcm32";
    } else if (format.tag == kFormatFloat && format.bitsPerSample == 32) {
        bytesPerSample = 4;
        out.sourceFormat = "float32";
    } else {
        error = "the WAV is format tag " + toString(format.tag) + " at " +
                toString(format.bitsPerSample) +
                " bits; this host reads PCM 16/24/32-bit and 32-bit float only";
        return false;
    }

    if (format.channels < 1 || format.channels > kMaxChannels) {
        error = "the WAV has " + toString(format.channels) + " channels; 1 to " +
                toString(kMaxChannels) + " are supported";
        return false;
    }
    if (format.sampleRate < 1 || format.sampleRate > 768000) {
        error = "the WAV claims a sample rate of " + toString(format.sampleRate) + " Hz";
        return false;
    }

    const std::uint64_t frameBytes =
        static_cast<std::uint64_t>(format.channels) * static_cast<std::uint64_t>(bytesPerSample);
    const std::uint64_t frames = audioBytes / frameBytes;  // a partial trailing frame is not audio

    out.channels = format.channels;
    out.sampleRate = static_cast<double>(format.sampleRate);
    out.samples.assign(static_cast<std::size_t>(format.channels),
                       std::vector<float>(static_cast<std::size_t>(frames), 0.0f));

    for (std::uint64_t frame = 0; frame < frames; ++frame) {
        const std::uint8_t* framePtr = audio + frame * frameBytes;
        for (int ch = 0; ch < format.channels; ++ch) {
            const std::uint8_t* samplePtr = framePtr + static_cast<std::size_t>(ch) * bytesPerSample;
            float value = 0.0f;
            switch (bytesPerSample) {
                case 2:
                    value = fromPcm16(samplePtr);
                    break;
                case 3:
                    value = fromPcm24(samplePtr);
                    break;
                default:
                    value = format.tag == kFormatFloat ? fromFloat32(samplePtr)
                                                       : fromPcm32(samplePtr);
                    break;
            }
            out.samples[static_cast<std::size_t>(ch)][static_cast<std::size_t>(frame)] = value;
        }
    }
    return true;
}

bool buildFloatWav(const std::vector<std::vector<float>>& channels, double sampleRate,
                   std::vector<std::uint8_t>& out, std::string& error) {
    out.clear();
    error.clear();
    if (channels.empty()) {
        error = "a WAV needs at least one channel";
        return false;
    }
    if (channels.size() > static_cast<std::size_t>(kMaxChannels)) {
        error = "a WAV with " + toString(static_cast<long long>(channels.size())) +
                " channels is more than this host writes";
        return false;
    }
    const std::size_t frames = channels.front().size();
    for (const std::vector<float>& channel : channels) {
        if (channel.size() != frames) {
            error = "every channel must hold the same number of frames";
            return false;
        }
    }
    if (!(sampleRate >= 1.0) || sampleRate > 768000.0) {
        error = "a WAV cannot declare a sample rate of " + toString(static_cast<long long>(sampleRate)) +
                " Hz";
        return false;
    }

    const std::uint64_t dataBytes =
        static_cast<std::uint64_t>(frames) * static_cast<std::uint64_t>(channels.size()) * 4ull;
    if (dataBytes > kMaxDataBytes) {
        error = "the render is larger than a WAV file can hold";
        return false;
    }

    const std::uint32_t rate = static_cast<std::uint32_t>(sampleRate + 0.5);
    const std::uint16_t channelCount = static_cast<std::uint16_t>(channels.size());
    const std::uint16_t blockAlign = static_cast<std::uint16_t>(channelCount * 4);
    const std::uint32_t byteRate = rate * blockAlign;

    // "WAVE" + fmt(8+18) + fact(8+4) + data(8+dataBytes). Float data is always word-aligned.
    const std::uint64_t riffSize = 4ull + 26ull + 12ull + 8ull + dataBytes;
    out.reserve(static_cast<std::size_t>(riffSize + 8));

    appendTag(out, "RIFF");
    appendLe32(out, static_cast<std::uint32_t>(riffSize));
    appendTag(out, "WAVE");

    appendTag(out, "fmt ");
    appendLe32(out, 18);  // an IEEE-float fmt chunk carries cbSize, unlike the 16-byte PCM one
    appendLe16(out, kFormatFloat);
    appendLe16(out, channelCount);
    appendLe32(out, rate);
    appendLe32(out, byteRate);
    appendLe16(out, blockAlign);
    appendLe16(out, 32);
    appendLe16(out, 0);  // cbSize

    appendTag(out, "fact");
    appendLe32(out, 4);
    appendLe32(out, static_cast<std::uint32_t>(frames));

    appendTag(out, "data");
    appendLe32(out, static_cast<std::uint32_t>(dataBytes));
    for (std::size_t frame = 0; frame < frames; ++frame) {
        for (const std::vector<float>& channel : channels) appendFloat32(out, channel[frame]);
    }
    return true;
}

bool readWavFile(const std::string& path, WavAudio& out, std::string& error) {
    const std::wstring wide = utf8ToWide(path);
    if (wide.empty()) {
        error = "cannot use \"" + path + "\" as a path";
        return false;
    }
    std::vector<std::uint8_t> bytes;
    if (!readFileLimited(wide, kMaxWavFileBytes, bytes, error)) return false;
    return parseWav(bytes.data(), bytes.size(), out, error);
}

bool writeWavFile(const std::string& path, const std::vector<std::vector<float>>& channels,
                  double sampleRate, std::string& error) {
    const std::wstring wide = utf8ToWide(path);
    if (wide.empty()) {
        error = "cannot use \"" + path + "\" as a path";
        return false;
    }
    std::vector<std::uint8_t> bytes;
    if (!buildFloatWav(channels, sampleRate, bytes, error)) return false;
    // Atomic: a render that dies half way must not leave a plausible-looking output behind.
    return writeFileAtomic(wide, bytes.data(), bytes.size(), error);
}

}  // namespace thedaw::util
