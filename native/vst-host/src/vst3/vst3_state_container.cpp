#include "vst3_state_container.h"

#include <array>
#include <cstring>
#include <limits>

namespace thedaw::vst3 {
namespace {

constexpr std::uint32_t kMagic = 0x21324356u;  // "VC2!" read little-endian
constexpr char kAlphabet[] =
    ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+";
static_assert(sizeof(kAlphabet) == 65, "alphabet must be exactly 64 characters plus NUL");

// BIT ORDER — the one detail that decides whether a state is interchangeable.
//
// The offline renderer (pedalboard) writes this container through JUCE, whose
// MemoryBlock::toBase64Encoding packs each 6-bit group with getBitRange(), and getBitRange is
// LEAST-significant-bit-first both within the group and within each byte. Packing the same bytes
// most-significant-bit-first produces text of exactly the same length and an encoding that
// round-trips perfectly against itself — which is why the mismatch survived until two hosts were
// compared directly. Measured on iZotope Vinyl and AIR Vocal Doubler: with this order the two
// hosts produce byte-identical containers for the same plugin at its defaults.

constexpr const char* kXmlHead =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?> <VST3PluginState>";
constexpr const char* kXmlTail = "</VST3PluginState>";
constexpr const char* kRootTag = "<VST3PluginState>";

// Inverse alphabet built once; 0xFF marks "not a member".
const std::array<std::uint8_t, 256>& reverseAlphabet() {
    static const std::array<std::uint8_t, 256> table = [] {
        std::array<std::uint8_t, 256> t{};
        t.fill(0xFF);
        for (std::uint8_t i = 0; i < 64; ++i) {
            t[static_cast<unsigned char>(kAlphabet[i])] = i;
        }
        return t;
    }();
    return table;
}

std::uint32_t readLe32(const std::uint8_t* p) {
    return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

void appendLe32(std::vector<std::uint8_t>& out, std::uint32_t value) {
    out.push_back(static_cast<std::uint8_t>(value & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFF));
}

// Pull the text of <tag>…</tag> out of `xml`. Returns:
//   found  = the element exists (self-closing counts, with empty text)
// The encoded alphabet contains no '<' or '>', so plain scanning is unambiguous here; a real
// XML parser would buy nothing and could only add ways to fail.
bool extractElement(const std::string& xml, const char* tag, std::string& text, bool& found) {
    found = false;
    text.clear();
    const std::string open = std::string("<") + tag + ">";
    const std::string close = std::string("</") + tag + ">";
    const std::size_t openAt = xml.find(open);
    if (openAt == std::string::npos) {
        const std::string selfClosing = std::string("<") + tag + "/>";
        if (xml.find(selfClosing) != std::string::npos) found = true;
        return true;  // absent is not an error; the caller decides
    }
    const std::size_t bodyAt = openAt + open.size();
    const std::size_t closeAt = xml.find(close, bodyAt);
    if (closeAt == std::string::npos) return false;  // opened but never closed: malformed
    text = xml.substr(bodyAt, closeAt - bodyAt);
    found = true;
    return true;
}

}  // namespace

std::string encodeStateText(const std::uint8_t* data, std::size_t size) {
    const std::uint64_t totalBits = static_cast<std::uint64_t>(size) * 8u;
    const std::size_t charCount = static_cast<std::size_t>((totalBits + 5u) / 6u);

    std::string out = std::to_string(size);
    out.push_back('.');
    out.reserve(out.size() + charCount);

    for (std::size_t i = 0; i < charCount; ++i) {
        std::uint8_t value = 0;
        for (int k = 0; k < 6; ++k) {
            const std::uint64_t bit = static_cast<std::uint64_t>(i) * 6u + static_cast<std::uint64_t>(k);
            if (bit >= totalBits) break;  // spare high bits stay zero
            const std::uint8_t byte = data[static_cast<std::size_t>(bit >> 3)];
            if ((byte >> (bit & 7)) & 1u) value |= static_cast<std::uint8_t>(1u << k);
        }
        out.push_back(kAlphabet[value]);
    }
    return out;
}

bool decodeStateText(const std::string& text, std::vector<std::uint8_t>& out, std::string& error) {
    out.clear();
    const std::size_t dot = text.find('.');
    if (dot == std::string::npos || dot == 0) {
        error = "state text has no '<length>.' prefix";
        return false;
    }
    std::uint64_t declared = 0;
    for (std::size_t i = 0; i < dot; ++i) {
        const char c = text[i];
        if (c < '0' || c > '9') {
            error = "state text length prefix is not a number";
            return false;
        }
        declared = declared * 10u + static_cast<std::uint64_t>(c - '0');
        if (declared > (1u << 28)) {  // 256 MB of plugin state is not a real state
            error = "state text declares an implausible length";
            return false;
        }
    }
    const std::size_t size = static_cast<std::size_t>(declared);
    const std::uint64_t totalBits = declared * 8u;
    const std::size_t expectedChars = static_cast<std::size_t>((totalBits + 5u) / 6u);
    const std::size_t haveChars = text.size() - dot - 1;
    if (haveChars != expectedChars) {
        error = "state text is truncated (" + std::to_string(haveChars) + " characters, expected " +
                std::to_string(expectedChars) + ")";
        return false;
    }

    out.assign(size, 0);
    const auto& reverse = reverseAlphabet();
    for (std::size_t i = 0; i < expectedChars; ++i) {
        const std::uint8_t value = reverse[static_cast<unsigned char>(text[dot + 1 + i])];
        if (value == 0xFF) {
            error = "state text contains a character outside the encoding alphabet";
            return false;
        }
        for (int k = 0; k < 6; ++k) {
            const std::uint64_t bit = static_cast<std::uint64_t>(i) * 6u + static_cast<std::uint64_t>(k);
            if (bit >= totalBits) break;  // spare high bits of the last character: not ours
            if ((value >> k) & 1u) {
                out[static_cast<std::size_t>(bit >> 3)] |= static_cast<std::uint8_t>(1u << (bit & 7));
            }
        }
    }
    return true;
}

std::vector<std::uint8_t> writeStateContainer(const PluginStateBlob& state) {
    std::string xml = kXmlHead;
    xml += "<IComponent>";
    xml += encodeStateText(state.component.data(), state.component.size());
    xml += "</IComponent>";
    if (state.hasController) {
        xml += "<IEditController>";
        xml += encodeStateText(state.controller.data(), state.controller.size());
        xml += "</IEditController>";
    }
    xml += kXmlTail;

    std::vector<std::uint8_t> out;
    out.reserve(xml.size() + 9);
    appendLe32(out, kMagic);
    appendLe32(out, static_cast<std::uint32_t>(xml.size()));
    out.insert(out.end(), xml.begin(), xml.end());
    out.push_back(0);
    return out;
}

bool readStateContainer(const std::uint8_t* data, std::size_t size, PluginStateBlob& out,
                        std::string& error) {
    out = PluginStateBlob{};
    if (data == nullptr || size < 9) {
        error = "state blob is too small to be a plugin state container";
        return false;
    }
    if (readLe32(data) != kMagic) {
        error = "state blob is not a plugin state container (bad magic)";
        return false;
    }
    const std::uint32_t xmlLength = readLe32(data + 4);
    if (xmlLength == 0 || static_cast<std::uint64_t>(xmlLength) + 8u > size) {
        error = "state blob declares " + std::to_string(xmlLength) + " bytes of XML but holds " +
                std::to_string(size) + " bytes in total";
        return false;
    }
    const std::string xml(reinterpret_cast<const char*>(data + 8), xmlLength);
    if (xml.find(kRootTag) == std::string::npos) {
        error = "state blob is not a VST3PluginState document";
        return false;
    }

    std::string componentText;
    std::string controllerText;
    bool haveComponent = false;
    bool haveController = false;
    if (!extractElement(xml, "IComponent", componentText, haveComponent) ||
        !extractElement(xml, "IEditController", controllerText, haveController)) {
        error = "state blob has an unterminated element";
        return false;
    }
    if (!haveComponent) {
        error = "state blob has no IComponent element";
        return false;
    }
    if (!componentText.empty() && !decodeStateText(componentText, out.component, error)) {
        error = "IComponent: " + error;
        return false;
    }
    if (haveController && !controllerText.empty() &&
        !decodeStateText(controllerText, out.controller, error)) {
        error = "IEditController: " + error;
        return false;
    }
    out.hasController = haveController;
    return true;
}

namespace {

// Vectors for selfTestStateCodec(). kKnownVectorText is bytes 00 01 02 ... FF in this encoding;
// kAirCapturedText is the <IComponent> text lifted verbatim out of a pedalboard `raw_state`
// capture of AIR Vocal Doubler, and kAirCapturedHead is what that capture's first 16 bytes were.
constexpr const char* kKnownVectorText =
        "256..Df.CPPAFb.BInvBLzfCO.QDRLAEUXwEXjgFavQGd7AHgHxHjThImfRJprBKs3xKvDiLyPSM1bCN4nyN7ziO"
        "+.TPBMDQEYzQHkjRKwTSN8DTQI0TTUkUWgUVZsEWc40WfElXiQVYlcFZoo1Zr0lauAWbxMGc0Y2c3kmd6wWe98Gf"
        "AJ3fDVngGhXhJtHiM53iPFojSRYkVdIlYp4lb1omeBZnhNJokZ5onlppqxZqt9JrwJ6rzVqs2hat5tKu856u.Grv"
        "CSbwFeLxIq7xL2ryOCczROM0Ua80Xms1ayc2d+M3gK93jWt4mid5puN6s696vGu7ySe81eO94q+972u++C";

constexpr const char* kAirCapturedText =
        "187.AMjUSA....PPIIEHV81XgwFHD8VchwVYxA.................................................."
        "............A....b........vO.....fUNz5yiBWmO...f+Hwff7C6QgwOI4VZzA.TRUzTEQkSA0TQE......."
        "........JU0PEAkboYWXzUFQgQWX.DP.BkGbgM2b.DP.C.PG.........nTUCUDTxklcgQWYDEFcgA";

constexpr std::uint8_t kAirCapturedHead[16] = {0x41, 0x43, 0x56, 0x53, 0x00, 0x00, 0x00, 0x00,
                                               0x41, 0x49, 0x52, 0x20, 0x56, 0x6F, 0x63, 0x61};
constexpr std::size_t kAirCapturedSize = 187;

std::string hexOf(const std::uint8_t* p, std::size_t n) {
    static const char* digits = "0123456789abcdef";
    std::string s;
    s.reserve(n * 3);
    for (std::size_t i = 0; i < n; ++i) {
        if (i != 0) s.push_back(' ');
        s.push_back(digits[p[i] >> 4]);
        s.push_back(digits[p[i] & 0x0F]);
    }
    return s;
}

}  // namespace

bool selfTestStateCodec(std::string& error) {
    error.clear();

    // 1. Every byte value, in order: our text must be the text JUCE writes for it, and must
    //    decode back to the same bytes. A most-significant-first packing fails the first half
    //    here while still passing the second, which is exactly how the bug hid.
    std::vector<std::uint8_t> all(256);
    for (std::size_t i = 0; i < all.size(); ++i) all[i] = static_cast<std::uint8_t>(i);
    const std::string encoded = encodeStateText(all.data(), all.size());
    if (encoded != kKnownVectorText) {
        error = "known vector 00..FF encoded to unexpected text: " + encoded.substr(0, 48) +
                "... expected " + std::string(kKnownVectorText).substr(0, 48) + "...";
        return false;
    }
    std::vector<std::uint8_t> back;
    if (!decodeStateText(encoded, back, error)) {
        error = "known vector failed to decode: " + error;
        return false;
    }
    if (back != all) {
        error = "known vector 00..FF did not survive encode/decode";
        return false;
    }

    // 2. A real pedalboard capture has to come out as the bytes pedalboard put in.
    std::vector<std::uint8_t> air;
    if (!decodeStateText(kAirCapturedText, air, error)) {
        error = "captured pedalboard state failed to decode: " + error;
        return false;
    }
    if (air.size() != kAirCapturedSize) {
        error = "captured pedalboard state decoded to " + std::to_string(air.size()) +
                " bytes, expected " + std::to_string(kAirCapturedSize);
        return false;
    }
    if (std::memcmp(air.data(), kAirCapturedHead, sizeof(kAirCapturedHead)) != 0) {
        error = "captured pedalboard state decoded to " +
                hexOf(air.data(), sizeof(kAirCapturedHead)) + ", expected " +
                hexOf(kAirCapturedHead, sizeof(kAirCapturedHead));
        return false;
    }
    if (encodeStateText(air.data(), air.size()) != kAirCapturedText) {
        error = "captured pedalboard state did not re-encode to the text it came from";
        return false;
    }

    // 3. The container around it round-trips, controller present and absent.
    for (int withController = 0; withController < 2; ++withController) {
        PluginStateBlob in;
        in.component = air;
        in.hasController = withController != 0;
        if (in.hasController) in.controller = all;
        const std::vector<std::uint8_t> blob = writeStateContainer(in);
        PluginStateBlob out;
        if (!readStateContainer(blob.data(), blob.size(), out, error)) {
            error = "container round trip failed: " + error;
            return false;
        }
        if (out.component != in.component || out.hasController != in.hasController ||
            out.controller != in.controller) {
            error = "container round trip changed the state";
            return false;
        }
    }
    return true;
}

}  // namespace thedaw::vst3
