#include "Sha1.h"

#include <cstring>

namespace thedaw::util {
namespace {

uint32_t rotl(uint32_t value, int bits) {
    return (value << bits) | (value >> (32 - bits));
}

}  // namespace

Sha1::Sha1() { reset(); }

void Sha1::reset() {
    state_[0] = 0x67452301u;
    state_[1] = 0xEFCDAB89u;
    state_[2] = 0x98BADCFEu;
    state_[3] = 0x10325476u;
    state_[4] = 0xC3D2E1F0u;
    bitCount_ = 0;
    bufferLen_ = 0;
    std::memset(buffer_, 0, sizeof(buffer_));
}

void Sha1::transform(const uint8_t block[64]) {
    uint32_t w[80];
    for (int i = 0; i < 16; ++i) {
        w[i] = (static_cast<uint32_t>(block[i * 4]) << 24) |
               (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
               (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
               static_cast<uint32_t>(block[i * 4 + 3]);
    }
    for (int i = 16; i < 80; ++i) {
        w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    uint32_t a = state_[0];
    uint32_t b = state_[1];
    uint32_t c = state_[2];
    uint32_t d = state_[3];
    uint32_t e = state_[4];

    for (int i = 0; i < 80; ++i) {
        uint32_t f = 0;
        uint32_t k = 0;
        if (i < 20) {
            f = (b & c) | (~b & d);
            k = 0x5A827999u;
        } else if (i < 40) {
            f = b ^ c ^ d;
            k = 0x6ED9EBA1u;
        } else if (i < 60) {
            f = (b & c) | (b & d) | (c & d);
            k = 0x8F1BBCDCu;
        } else {
            f = b ^ c ^ d;
            k = 0xCA62C1D6u;
        }
        const uint32_t temp = rotl(a, 5) + f + e + k + w[i];
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = temp;
    }

    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
}

void Sha1::update(const void* data, size_t size) {
    const uint8_t* bytes = static_cast<const uint8_t*>(data);
    bitCount_ += static_cast<uint64_t>(size) * 8u;
    while (size > 0) {
        const size_t space = 64 - bufferLen_;
        const size_t take = size < space ? size : space;
        std::memcpy(buffer_ + bufferLen_, bytes, take);
        bufferLen_ += take;
        bytes += take;
        size -= take;
        if (bufferLen_ == 64) {
            transform(buffer_);
            bufferLen_ = 0;
        }
    }
}

void Sha1::finish(uint8_t out[20]) {
    const uint64_t bits = bitCount_;
    const uint8_t padStart = 0x80;
    update(&padStart, 1);
    const uint8_t zero = 0x00;
    while (bufferLen_ != 56) update(&zero, 1);

    uint8_t lengthBytes[8];
    for (int i = 0; i < 8; ++i) {
        lengthBytes[i] = static_cast<uint8_t>((bits >> (56 - i * 8)) & 0xFFu);
    }
    // update() would fold these into bitCount_, which is already final.
    std::memcpy(buffer_ + bufferLen_, lengthBytes, 8);
    transform(buffer_);
    bufferLen_ = 0;

    for (int i = 0; i < 5; ++i) {
        out[i * 4] = static_cast<uint8_t>((state_[i] >> 24) & 0xFFu);
        out[i * 4 + 1] = static_cast<uint8_t>((state_[i] >> 16) & 0xFFu);
        out[i * 4 + 2] = static_cast<uint8_t>((state_[i] >> 8) & 0xFFu);
        out[i * 4 + 3] = static_cast<uint8_t>(state_[i] & 0xFFu);
    }
}

void sha1(const void* data, size_t size, uint8_t out[20]) {
    Sha1 hash;
    hash.update(data, size);
    hash.finish(out);
}

std::string sha1Hex(const std::string& text) {
    uint8_t digest[20];
    sha1(text.data(), text.size(), digest);
    static const char* kHex = "0123456789abcdef";
    std::string out;
    out.reserve(40);
    for (uint8_t byte : digest) {
        out.push_back(kHex[byte >> 4]);
        out.push_back(kHex[byte & 0x0Fu]);
    }
    return out;
}

}  // namespace thedaw::util
