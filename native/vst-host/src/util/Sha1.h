// SHA-1 (RFC 3174). Used for the RFC 6455 Sec-WebSocket-Accept value only --
// never for anything security-bearing, because SHA-1 is not collision resistant.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace thedaw::util {

class Sha1 {
public:
    Sha1();
    void update(const void* data, size_t size);
    // Writes the 20-byte digest and leaves the object unusable until reset().
    void finish(uint8_t out[20]);
    void reset();

private:
    void transform(const uint8_t block[64]);

    uint32_t state_[5];
    uint64_t bitCount_;
    uint8_t buffer_[64];
    size_t bufferLen_;
};

void sha1(const void* data, size_t size, uint8_t out[20]);
std::string sha1Hex(const std::string& text);

}  // namespace thedaw::util
