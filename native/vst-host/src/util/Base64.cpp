#include "Base64.h"

namespace thedaw::util {
namespace {

const char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int decodeChar(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool isAsciiSpace(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

}  // namespace

std::string base64Encode(const void* data, size_t size) {
    const uint8_t* bytes = static_cast<const uint8_t*>(data);
    std::string out;
    out.reserve(((size + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= size) {
        const uint32_t triple = (static_cast<uint32_t>(bytes[i]) << 16) |
                                (static_cast<uint32_t>(bytes[i + 1]) << 8) |
                                static_cast<uint32_t>(bytes[i + 2]);
        out.push_back(kAlphabet[(triple >> 18) & 0x3Fu]);
        out.push_back(kAlphabet[(triple >> 12) & 0x3Fu]);
        out.push_back(kAlphabet[(triple >> 6) & 0x3Fu]);
        out.push_back(kAlphabet[triple & 0x3Fu]);
        i += 3;
    }
    const size_t remaining = size - i;
    if (remaining == 1) {
        const uint32_t triple = static_cast<uint32_t>(bytes[i]) << 16;
        out.push_back(kAlphabet[(triple >> 18) & 0x3Fu]);
        out.push_back(kAlphabet[(triple >> 12) & 0x3Fu]);
        out.push_back('=');
        out.push_back('=');
    } else if (remaining == 2) {
        const uint32_t triple = (static_cast<uint32_t>(bytes[i]) << 16) |
                                (static_cast<uint32_t>(bytes[i + 1]) << 8);
        out.push_back(kAlphabet[(triple >> 18) & 0x3Fu]);
        out.push_back(kAlphabet[(triple >> 12) & 0x3Fu]);
        out.push_back(kAlphabet[(triple >> 6) & 0x3Fu]);
        out.push_back('=');
    }
    return out;
}

bool base64Decode(const std::string& text, std::vector<uint8_t>& out) {
    out.clear();
    uint32_t accumulator = 0;
    int bits = 0;
    size_t symbols = 0;
    size_t padding = 0;
    for (char c : text) {
        if (isAsciiSpace(c)) continue;
        if (c == '=') {
            ++padding;
            if (padding > 2) return false;
            ++symbols;
            continue;
        }
        if (padding != 0) return false;  // data after padding
        const int value = decodeChar(c);
        if (value < 0) return false;
        accumulator = (accumulator << 6) | static_cast<uint32_t>(value);
        bits += 6;
        ++symbols;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>((accumulator >> bits) & 0xFFu));
        }
    }
    if (symbols % 4 != 0) return false;
    // Leftover bits must be zero padding, never data.
    if (bits > 0 && (accumulator & ((1u << bits) - 1u)) != 0) return false;
    return true;
}

}  // namespace thedaw::util
