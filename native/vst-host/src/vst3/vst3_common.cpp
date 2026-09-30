#include "vst3_common.h"

#include <cstring>

namespace thedaw::vst3 {
namespace {

// UTF-16 -> UTF-8. Plugin names arrive as UTF-16 and can legitimately contain non-ASCII
// (accents, ™, CJK); doing this by hand avoids dragging in a locale-dependent conversion.
void appendUtf8(std::string& out, std::uint32_t codePoint) {
    if (codePoint < 0x80) {
        out.push_back(static_cast<char>(codePoint));
    } else if (codePoint < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else if (codePoint < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
        out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (codePoint >> 18)));
        out.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    }
}

constexpr char kHexDigits[] = "0123456789ABCDEF";

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

}  // namespace

std::string fromVstString(const Steinberg::Vst::TChar* text, std::size_t maxChars) {
    std::string out;
    if (text == nullptr) return out;
    for (std::size_t i = 0; i < maxChars; ++i) {
        const std::uint32_t unit = static_cast<std::uint16_t>(text[i]);
        if (unit == 0) break;
        std::uint32_t codePoint = unit;
        // Surrogate pair: combine, but only when the low half is actually there.
        if (unit >= 0xD800 && unit <= 0xDBFF && i + 1 < maxChars) {
            const std::uint32_t low = static_cast<std::uint16_t>(text[i + 1]);
            if (low >= 0xDC00 && low <= 0xDFFF) {
                codePoint = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                ++i;
            }
        }
        appendUtf8(out, codePoint);
    }
    return out;
}

std::string fromAsciiField(const char* text, std::size_t maxChars) {
    if (text == nullptr) return {};
    std::size_t len = 0;
    while (len < maxChars && text[len] != '\0') ++len;
    std::string out(text, len);
    // Vendors pad these fields with spaces often enough that trailing blanks would show up in
    // the UI; trim them here rather than in three call sites.
    while (!out.empty() && (out.back() == ' ' || out.back() == '\t')) out.pop_back();
    return out;
}

void toVstString128(const std::string& text, Steinberg::Vst::TChar* out) {
    if (out == nullptr) return;
    std::size_t written = 0;
    std::size_t i = 0;
    // We only ever put our own ASCII host name / attribute keys through here, so a plain
    // byte-to-unit widening is exact; anything >= 0x80 becomes U+FFFD rather than garbage.
    while (i < text.size() && written < 127) {
        const unsigned char c = static_cast<unsigned char>(text[i++]);
        out[written++] = static_cast<Steinberg::Vst::TChar>(c < 0x80 ? c : 0xFFFD);
    }
    out[written] = 0;
}

std::string cidToHex(const Steinberg::TUID& cid) {
    std::string hex;
    hex.reserve(32);
    for (int i = 0; i < 16; ++i) {
        const unsigned char byte = static_cast<unsigned char>(cid[i]);
        hex.push_back(kHexDigits[byte >> 4]);
        hex.push_back(kHexDigits[byte & 0x0F]);
    }
    return hex;
}

bool hexToCid(const std::string& hex, Steinberg::TUID& out) {
    if (hex.size() != 32) return false;
    for (int i = 0; i < 16; ++i) {
        const int hi = hexValue(hex[static_cast<std::size_t>(i) * 2]);
        const int lo = hexValue(hex[static_cast<std::size_t>(i) * 2 + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i] = static_cast<char>((hi << 4) | lo);
    }
    return true;
}

}  // namespace thedaw::vst3
