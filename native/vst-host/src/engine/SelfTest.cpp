#include "SelfTest.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../net/WsFrame.h"
#include "../net/WsServer.h"
#include "../util/Base64.h"
#include "../util/Json.h"
#include "../util/Sha1.h"
#include "../util/SpscQueue.h"
#include "../util/Wav.h"
#include "AudioFrame.h"
#include "ChannelMap.h"
#include "DelayLine.h"

namespace thedaw {
namespace {

int gChecks = 0;
int gFailures = 0;

void check(bool condition, const char* what) {
    ++gChecks;
    if (!condition) {
        ++gFailures;
        std::printf("  FAIL  %s\n", what);
    }
}

void checkEqual(const std::string& actual, const std::string& expected, const char* what) {
    ++gChecks;
    if (actual != expected) {
        ++gFailures;
        std::printf("  FAIL  %s\n        expected: %s\n        actual:   %s\n", what,
                    expected.c_str(), actual.c_str());
    }
}

void section(const char* name) { std::printf("%s\n", name); }

// ---------------------------------------------------------------------------

void testSha1() {
    section("SHA-1 (RFC 3174)");
    checkEqual(util::sha1Hex(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709", "empty");
    checkEqual(util::sha1Hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d", "abc");
    checkEqual(util::sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
               "84983e441c3bd26ebaae4aa1f95129e5e54670f1", "56-byte vector");
    checkEqual(util::sha1Hex(std::string(1000000, 'a')),
               "34aa973cd4c4daa4f61eeb2bdbad27316534016f", "one million a");
    // Incremental update must agree with the one-shot digest across the 55/56/64
    // byte boundary, which is where the padding block splits.
    for (size_t total : {size_t{54}, size_t{55}, size_t{56}, size_t{63}, size_t{64},
                         size_t{65}, size_t{200}}) {
        const std::string data(total, 'x');
        util::Sha1 incremental;
        for (size_t i = 0; i < total; i += 7) {
            incremental.update(data.data() + i, (total - i) < 7 ? (total - i) : 7);
        }
        uint8_t digest[20];
        incremental.finish(digest);
        static const char* kHex = "0123456789abcdef";
        std::string hex;
        for (uint8_t byte : digest) {
            hex.push_back(kHex[byte >> 4]);
            hex.push_back(kHex[byte & 0x0Fu]);
        }
        checkEqual(hex, util::sha1Hex(data), "chunked update matches one-shot");
    }
}

void testBase64() {
    section("base64 (RFC 4648)");
    struct Vector {
        const char* plain;
        const char* encoded;
    };
    const Vector vectors[] = {
        {"", ""},           {"f", "Zg=="},         {"fo", "Zm8="},
        {"foo", "Zm9v"},    {"foob", "Zm9vYg=="},  {"fooba", "Zm9vYmE="},
        {"foobar", "Zm9vYmFy"},
    };
    for (const Vector& vector : vectors) {
        const std::string encoded =
            util::base64Encode(vector.plain, std::strlen(vector.plain));
        checkEqual(encoded, vector.encoded, "encode");
        std::vector<uint8_t> decoded;
        check(util::base64Decode(vector.encoded, decoded), "decode succeeds");
        checkEqual(std::string(decoded.begin(), decoded.end()), vector.plain, "decode");
    }
    std::vector<uint8_t> sink;
    check(!util::base64Decode("Zg=", sink), "rejects a short quantum");
    check(!util::base64Decode("Zg===", sink), "rejects over-padding");
    check(!util::base64Decode("Zm9v!A==", sink), "rejects a non-alphabet byte");
    check(!util::base64Decode("Zg==Zg==", sink), "rejects data after padding");
    check(util::base64Decode("Zm9v\r\nYmFy", sink), "skips ASCII whitespace");
    checkEqual(std::string(sink.begin(), sink.end()), "foobar", "whitespace decode");

    // Round trip over every byte value.
    std::vector<uint8_t> all(256);
    for (int i = 0; i < 256; ++i) all[static_cast<size_t>(i)] = static_cast<uint8_t>(i);
    std::vector<uint8_t> back;
    check(util::base64Decode(util::base64Encode(all.data(), all.size()), back),
          "256-byte round trip decodes");
    check(back == all, "256-byte round trip matches");
}

void testJson() {
    section("JSON");
    json::Value value;
    std::string error;

    check(json::parse(R"({"op":"set_param","index":3,"value":0.25,"on":true,"x":null})",
                      value, error),
          "parses a control message");
    check(value.isObject(), "root is an object");
    checkEqual(value.stringOr("op", ""), "set_param", "string field");
    check(value.numberOr("index", -1) == 3.0, "integer field");
    check(value.numberOr("value", -1) == 0.25, "fraction field");
    check(value.boolOr("on", false), "bool field");
    check(value.find("x") != nullptr && value.find("x")->isNull(), "null field");

    check(json::parse(R"({"s":"a\"b\\c\/d\be\ff\ng\rh\ti\u0041\u00e9\ud83d\ude00"})", value,
                      error),
          "parses escapes");
    const std::string decoded = value.stringOr("s", "");
    check(decoded.find("a\"b\\c/d") == 0, "simple escapes");
    check(decoded.find("A\xC3\xA9\xF0\x9F\x98\x80") != std::string::npos,
          "\\u, 2-byte and surrogate pair");

    check(json::parse(R"({"list":[1,2,{"n":[true,false,null]}]})", value, error),
          "parses nesting");
    const json::Value* list = value.find("list");
    check(list != nullptr && list->isArray() && list->array.size() == 3, "array size");

    const char* malformed[] = {
        "{",          "{\"a\"}",     "{\"a\":}",       "[1,]",
        "{'a':1}",    "{\"a\":01}",  "{\"a\":1.}",     "{\"a\":1e}",
        "nul",        "{\"a\":\"\\u00\"}", "{\"a\":\"\\ud800\"}",
        "{\"a\":\"unterminated",     "{\"a\":1}trailing",
        "{\"a\":\"\x01\"}",
    };
    for (const char* text : malformed) {
        ++gChecks;
        if (json::parse(text, value, error)) {
            ++gFailures;
            std::printf("  FAIL  accepted malformed JSON: %s\n", text);
        }
    }

    // Depth limit.
    std::string deep;
    for (int i = 0; i < json::kMaxDepth + 4; ++i) deep += "[";
    for (int i = 0; i < json::kMaxDepth + 4; ++i) deep += "]";
    check(!json::parse(deep, value, error), "rejects over-deep nesting");

    // Writer.
    json::Writer writer;
    writer.beginObject()
        .strField("ev", "ready")
        .intField("protocol", 1)
        .key("plugin")
        .beginObject()
        .strField("name", "A \"quoted\" \\ name\n")
        .endObject()
        .numField("tail_seconds", 0.5)
        .boolField("has_editor", false)
        .key("warnings")
        .beginArray()
        .valueString("one")
        .valueString("two")
        .endArray()
        .endObject();
    const std::string text = writer.text();
    check(json::parse(text, value, error), "writer output re-parses");
    check(value.stringOr("ev", "") == "ready", "writer round trip: ev");
    const json::Value* plugin = value.find("plugin");
    check(plugin != nullptr && plugin->stringOr("name", "") == "A \"quoted\" \\ name\n",
          "writer round trip: escaped name");
    check(value.numberOr("tail_seconds", -1) == 0.5, "writer round trip: number");

    // Invalid UTF-8 in a plugin name must not produce invalid JSON.
    json::Writer bad;
    // The literal is split so \xFE cannot swallow the following 'b': C++ hex
    // escapes are greedy and "\xFEbytes" would be one out-of-range escape.
    bad.beginObject().strField("name", std::string("bad\xFF\xFE" "bytes")).endObject();
    check(json::parse(bad.text(), value, error), "invalid UTF-8 is sanitised");

    checkEqual(json::formatNumber(0.0), "0", "formats 0");
    checkEqual(json::formatNumber(-1.0), "-1", "formats -1");
    checkEqual(json::formatNumber(0.5), "0.5", "formats 0.5");
    checkEqual(json::formatNumber(1234.5), "1234.5", "formats 1234.5");
    check(json::parse("[" + json::formatNumber(0.1) + "]", value, error) &&
              value.array[0].number == 0.1,
          "0.1 round trips");
}

void testAudioFrameHeader() {
    section("audio frame header");
    AudioFrameHeader header;
    header.magic = kFrameMagic;
    header.type = kFrameTypeAudioOut;
    header.channels = 2;
    header.flags = kFlagPlaying | kFlagDiscontinuity;
    header.seq = 0xDEADBEEFu;
    header.frames = 512;
    header.positionSamples = 123456.75;
    header.tempoBpm = 128.25;

    uint8_t bytes[kAudioFrameHeaderSize];
    writeAudioFrameHeader(bytes, header);
    check(bytes[0] == 0x56 && bytes[1] == 0x53 && bytes[2] == 0x54 && bytes[3] == 0x4C,
          "magic is little-endian \"VSTL\"");

    AudioFrameHeader back;
    check(readAudioFrameHeader(bytes, sizeof(bytes), back), "reads back");
    check(back.magic == header.magic && back.type == header.type &&
              back.channels == header.channels && back.flags == header.flags &&
              back.seq == header.seq && back.frames == header.frames,
          "integer fields round trip");
    check(back.positionSamples == header.positionSamples && back.tempoBpm == header.tempoBpm,
          "double fields round trip");
    check(!readAudioFrameHeader(bytes, kAudioFrameHeaderSize - 1, back),
          "rejects a short header");
}

// Feeds bytes through FrameReader the way the audio thread does.
bool feed(net::FrameReader& reader, const std::vector<uint8_t>& bytes) {
    size_t offset = 0;
    while (offset < bytes.size()) {
        size_t space = 0;
        uint8_t* target = reader.writePointer(space);
        if (target == nullptr || space == 0) return false;
        const size_t take = space < (bytes.size() - offset) ? space : (bytes.size() - offset);
        std::memcpy(target, bytes.data() + offset, take);
        reader.commitWrite(take);
        offset += take;
    }
    return true;
}

void testWebSocketFraming() {
    section("WebSocket framing (RFC 6455)");
    const uint8_t mask[4] = {0x37, 0xFA, 0x21, 0x3D};

    {  // Unmasked header shapes.
        uint8_t header[10];
        check(net::writeFrameHeader(header, net::Opcode::Text, true, 5) == 2,
              "7-bit length header is 2 bytes");
        check(header[1] == 5, "7-bit length value");
        check(net::writeFrameHeader(header, net::Opcode::Binary, true, 200) == 4,
              "126 length header is 4 bytes");
        check(header[1] == 126 && header[2] == 0 && header[3] == 200, "126 length value");
        check(net::writeFrameHeader(header, net::Opcode::Binary, true, 70000) == 10,
              "127 length header is 10 bytes");
        check(header[1] == 127 && header[6] == 0x00 && header[7] == 0x01 &&
                  header[8] == 0x11 && header[9] == 0x70,
              "127 length value");
    }

    {  // Masking: the canonical RFC example.
        const char payload[] = "Hello";
        std::vector<uint8_t> frame = net::buildClientFrame(
            net::Opcode::Text, true, reinterpret_cast<const uint8_t*>(payload), 5, mask);
        const uint8_t expected[] = {0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d,
                                    0x7f, 0x9f, 0x4d, 0x51, 0x58};
        check(frame.size() == sizeof(expected), "masked frame length");
        check(std::memcmp(frame.data(), expected, sizeof(expected)) == 0,
              "masked frame bytes match RFC 6455 section 5.7");

        net::FrameReader reader;
        reader.reserve(64 * 1024);
        check(feed(reader, frame), "feeds the masked frame");
        net::FrameReader::Message message;
        check(reader.next(message) == net::FrameReader::Status::Message, "one message");
        check(message.opcode == net::Opcode::Text && message.size == 5 &&
                  std::memcmp(message.data, payload, 5) == 0,
              "unmasked payload");
        check(reader.next(message) == net::FrameReader::Status::NeedMore, "then empty");
    }

    {  // Fragmentation across three frames plus an interleaved ping.
        net::FrameReader reader;
        reader.reserve(64 * 1024);
        const char a[] = "frag";
        const char b[] = "ment";
        const char c[] = "ed!";
        const char ping[] = "pp";
        std::vector<uint8_t> bytes;
        auto append = [&bytes](const std::vector<uint8_t>& more) {
            bytes.insert(bytes.end(), more.begin(), more.end());
        };
        append(net::buildClientFrame(net::Opcode::Text, false,
                                     reinterpret_cast<const uint8_t*>(a), 4, mask));
        append(net::buildClientFrame(net::Opcode::Continuation, false,
                                     reinterpret_cast<const uint8_t*>(b), 4, mask));
        append(net::buildClientFrame(net::Opcode::Ping, true,
                                     reinterpret_cast<const uint8_t*>(ping), 2, mask));
        append(net::buildClientFrame(net::Opcode::Continuation, true,
                                     reinterpret_cast<const uint8_t*>(c), 3, mask));
        check(feed(reader, bytes), "feeds the fragmented stream");

        net::FrameReader::Message message;
        check(reader.next(message) == net::FrameReader::Status::Message, "ping arrives first");
        check(message.opcode == net::Opcode::Ping && message.size == 2,
              "control frame passes through the fragmented message");
        check(reader.next(message) == net::FrameReader::Status::Message, "assembled message");
        check(message.opcode == net::Opcode::Text && message.size == 11 &&
                  std::memcmp(message.data, "fragmented!", 11) == 0,
              "fragments reassemble in order");
    }

    {  // 126 and 127 length paths carry their payload intact.
        for (size_t size : {size_t{125}, size_t{126}, size_t{65535}, size_t{65536}}) {
            std::vector<uint8_t> payload(size);
            for (size_t i = 0; i < size; ++i) payload[i] = static_cast<uint8_t>(i * 31u + 7u);
            net::FrameReader reader;
            reader.reserve(256 * 1024);
            check(feed(reader, net::buildClientFrame(net::Opcode::Binary, true,
                                                     payload.data(), size, mask)),
                  "feeds a sized frame");
            net::FrameReader::Message message;
            check(reader.next(message) == net::FrameReader::Status::Message,
                  "sized frame parses");
            check(message.size == size &&
                      std::memcmp(message.data, payload.data(), size) == 0,
                  "sized frame payload survives");
        }
    }

    {  // Protocol violations.
        net::FrameReader reader;
        reader.reserve(4096);
        const uint8_t unmasked[] = {0x81, 0x02, 'h', 'i'};
        check(feed(reader, std::vector<uint8_t>(unmasked, unmasked + sizeof(unmasked))),
              "feeds an unmasked frame");
        net::FrameReader::Message message;
        check(reader.next(message) == net::FrameReader::Status::ProtocolError,
              "rejects an unmasked client frame");
        check(reader.closeCode() == net::kCloseProtocolError, "close code 1002");
    }
    {
        net::FrameReader reader;
        reader.reserve(4096);
        const uint8_t rsv[] = {0xC1, 0x82, 0x00, 0x00, 0x00, 0x00, 'h', 'i'};
        check(feed(reader, std::vector<uint8_t>(rsv, rsv + sizeof(rsv))), "feeds RSV1");
        net::FrameReader::Message message;
        check(reader.next(message) == net::FrameReader::Status::ProtocolError,
              "rejects a set reserved bit");
    }
    {
        net::FrameReader reader;
        reader.reserve(4096);
        // Fragmented control frame (FIN clear on a ping).
        const uint8_t badPing[] = {0x09, 0x80, 0x00, 0x00, 0x00, 0x00};
        check(feed(reader, std::vector<uint8_t>(badPing, badPing + sizeof(badPing))),
              "feeds a fragmented ping");
        net::FrameReader::Message message;
        check(reader.next(message) == net::FrameReader::Status::ProtocolError,
              "rejects a fragmented control frame");
    }
    {
        net::FrameReader reader;
        reader.reserve(4096);
        // 64-bit length with the high bit set.
        const uint8_t huge[] = {0x82, 0xFF, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
        check(feed(reader, std::vector<uint8_t>(huge, huge + sizeof(huge))),
              "feeds a negative 64-bit length");
        net::FrameReader::Message message;
        check(reader.next(message) == net::FrameReader::Status::ProtocolError,
              "rejects a 64-bit length with the high bit set");
    }
    {
        net::FrameReader reader;
        reader.reserve(4096);
        // 9 MB announced: over the 8 MB ceiling.
        // 0x900000 == 9 MB, announced as a 64-bit big-endian length.
        const uint8_t big[] = {0x82, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00,
                               0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
        check(feed(reader, std::vector<uint8_t>(big, big + sizeof(big))),
              "feeds an oversized length");
        net::FrameReader::Message message;
        check(reader.next(message) == net::FrameReader::Status::MessageTooBig,
              "rejects a message over 8 MB");
        check(reader.closeCode() == net::kCloseTooBig, "close code 1009");
    }
}

void testHandshake() {
    section("WebSocket handshake");
    // RFC 6455 section 1.3 worked example.
    checkEqual(net::computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
               "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "Sec-WebSocket-Accept");

    net::HttpRequest request;
    std::string error;
    const std::string good =
        "GET /live HTTP/1.1\r\n"
        "Host: 127.0.0.1:9000\r\n"
        "upgrade: WebSocket\r\n"
        "Connection: keep-alive, Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n";
    check(net::parseHttpRequest(good, request, error), "parses the request");
    checkEqual(request.method, "GET", "method");
    check(request.header("UPGRADE") != nullptr, "header lookup is case-insensitive");

    std::string acceptKey;
    std::string reason;
    check(net::evaluateHandshake(request, false, acceptKey, reason) ==
              net::HandshakeOutcome::Accept,
          "accepts a valid upgrade");
    checkEqual(acceptKey, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "accept key from the request");
    check(net::evaluateHandshake(request, true, acceptKey, reason) ==
              net::HandshakeOutcome::Busy,
          "refuses a second client with 409");

    net::HttpRequest wrongVersion = request;
    for (auto& header : wrongVersion.headers) {
        if (header.first == "Sec-WebSocket-Version") header.second = "8";
    }
    check(net::evaluateHandshake(wrongVersion, false, acceptKey, reason) ==
              net::HandshakeOutcome::UpgradeRequired,
          "refuses version 8");

    net::HttpRequest noKey = request;
    noKey.headers.clear();
    noKey.headers.emplace_back("Upgrade", "websocket");
    noKey.headers.emplace_back("Connection", "Upgrade");
    noKey.headers.emplace_back("Sec-WebSocket-Version", "13");
    check(net::evaluateHandshake(noKey, false, acceptKey, reason) ==
              net::HandshakeOutcome::BadRequest,
          "refuses a missing key");

    net::HttpRequest hostile = request;
    hostile.headers.emplace_back("Origin", "https://evil.example.com");
    check(net::evaluateHandshake(hostile, false, acceptKey, reason) ==
              net::HandshakeOutcome::Forbidden,
          "refuses a foreign origin even when idle");
    check(net::evaluateHandshake(hostile, true, acceptKey, reason) ==
              net::HandshakeOutcome::Forbidden,
          "a foreign origin is 403 and never 409");

    const char* allowed[] = {
        "", "null", "NULL", "file://", "app://thedaw", "tauri://localhost",
        "http://localhost", "http://localhost:5173", "https://127.0.0.1:8600",
        "HTTP://LOCALHOST:1234", "http://[::1]:5173",
    };
    for (const char* origin : allowed) {
        ++gChecks;
        if (!net::originAllowed(origin)) {
            ++gFailures;
            std::printf("  FAIL  origin should be allowed: %s\n", origin);
        }
    }
    const char* refused[] = {
        "http://evil.example.com",   "https://localhost.evil.com",
        "http://127.0.0.1.evil.com", "http://10.0.0.5:8080",
        "https://sub.localhost",     "http://user@localhost",
        "http://localhost@evil.com", "http:/localhost",
        "https://[::2]",
    };
    for (const char* origin : refused) {
        ++gChecks;
        if (net::originAllowed(origin)) {
            ++gFailures;
            std::printf("  FAIL  origin should be refused: %s\n", origin);
        }
    }
}

void testSpscQueue() {
    section("SPSC queue");
    util::SpscQueue<int, 4> queue;
    check(queue.empty(), "starts empty");
    check(queue.push(1) && queue.push(2) && queue.push(3) && queue.push(4),
          "accepts exactly capacity items");
    check(!queue.push(5), "refuses when full");
    int value = 0;
    check(queue.pop(value) && value == 1, "pops in order (1)");
    check(queue.pop(value) && value == 2, "pops in order (2)");
    check(queue.push(5), "accepts again after popping");
    check(queue.pop(value) && value == 3, "pops in order (3)");
    check(queue.pop(value) && value == 4, "pops in order (4)");
    check(queue.pop(value) && value == 5, "pops the wrapped item");
    check(!queue.pop(value), "empty again");

    // In-place slots keep their capacity, which is what makes the audio thread
    // allocation-free after warm-up.
    util::SpscQueue<std::string, 2> strings;
    strings.forEachSlot([](std::string& slot) { slot.reserve(256); });
    std::string* slot = strings.writeSlot();
    check(slot != nullptr && slot->capacity() >= 256, "slots keep reserved capacity");
    slot->assign("hello");
    strings.commitWrite();
    std::string* read = strings.readSlot();
    check(read != nullptr && *read == "hello", "in-place publish");
    read->clear();
    strings.commitRead();
    check(strings.writeSlot()->capacity() >= 256, "capacity survives a round trip");
}

void testChannelMapAndDelay() {
    section("channel map and bypass delay");
    const int frames = 8;
    std::vector<float> left(frames);
    std::vector<float> right(frames);
    std::vector<float> outA(frames);
    std::vector<float> outB(frames);
    for (int i = 0; i < frames; ++i) {
        left[static_cast<size_t>(i)] = static_cast<float>(i) * 0.125f - 0.5f;
        right[static_cast<size_t>(i)] = static_cast<float>(i) * -0.0625f + 0.25f;
    }
    const float* stereoIn[2] = {left.data(), right.data()};
    float* stereoOut[2] = {outA.data(), outB.data()};

    mapChannels(stereoIn, 2, stereoOut, 2, frames);
    check(outA == left && outB == right, "stereo to stereo is a copy");

    // mono -> stereo -> mono is bit exact, which the null-plugin tests rely on.
    const float* monoIn[1] = {left.data()};
    mapChannels(monoIn, 1, stereoOut, 2, frames);
    check(outA == left && outB == left, "mono duplicates");
    const float* dupped[2] = {outA.data(), outB.data()};
    std::vector<float> mono(frames);
    float* monoOut[1] = {mono.data()};
    mapChannels(dupped, 2, monoOut, 1, frames);
    check(mono == left, "dup then average is bit exact");

    DelayLine delay;
    delay.prepare(2, 16, frames);
    check(delay.setDelay(4), "sets a delay inside capacity");
    check(!delay.setDelay(99), "refuses a delay over capacity");

    std::vector<float> delayedA(frames, 0.0f);
    std::vector<float> delayedB(frames, 0.0f);
    float* delayedOut[2] = {delayedA.data(), delayedB.data()};
    delay.process(stereoIn, delayedOut, 2, frames);
    bool leadingSilence = true;
    for (int i = 0; i < 4; ++i) {
        if (delayedA[static_cast<size_t>(i)] != 0.0f) leadingSilence = false;
    }
    check(leadingSilence, "the first `delay` samples are silent");
    bool aligned = true;
    for (int i = 4; i < frames; ++i) {
        if (delayedA[static_cast<size_t>(i)] != left[static_cast<size_t>(i - 4)]) {
            aligned = false;
        }
    }
    check(aligned, "the dry signal comes out delayed by exactly `delay` samples");

    delay.setDelay(0);
    delay.process(stereoIn, delayedOut, 2, frames);
    check(delayedA == left && delayedB == right, "zero delay is a passthrough");

    // The bypass crossfade form must be exact when wet == dry.
    bool exact = true;
    for (int step = 0; step <= 100; ++step) {
        const float gain = static_cast<float>(step) / 100.0f;
        for (int i = 0; i < frames; ++i) {
            const float wet = left[static_cast<size_t>(i)];
            const float dry = wet;
            if (wet + gain * (dry - wet) != wet) exact = false;
        }
    }
    check(exact, "wet + g*(dry-wet) is bit exact for a passthrough at every gain");
}

// ---------------------------------------------------------------------------

// Builds a RIFF/WAVE by hand so the reader is tested against bytes, not against our own writer.
std::vector<uint8_t> makeWav(uint16_t formatTag, uint16_t bitsPerSample, uint16_t channels,
                             uint32_t sampleRate, const std::vector<uint8_t>& audio,
                             bool extensible = false, const std::vector<uint8_t>& extraChunk = {}) {
    auto put32 = [](std::vector<uint8_t>& out, uint32_t value) {
        out.push_back(static_cast<uint8_t>(value & 0xFF));
        out.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
        out.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
        out.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
    };
    auto put16 = [](std::vector<uint8_t>& out, uint16_t value) {
        out.push_back(static_cast<uint8_t>(value & 0xFF));
        out.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    };
    auto putTag = [](std::vector<uint8_t>& out, const char* tag) {
        for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>(tag[i]));
    };

    const uint16_t blockAlign = static_cast<uint16_t>(channels * (bitsPerSample / 8));
    std::vector<uint8_t> fmt;
    put16(fmt, extensible ? uint16_t{0xFFFE} : formatTag);
    put16(fmt, channels);
    put32(fmt, sampleRate);
    put32(fmt, sampleRate * blockAlign);
    put16(fmt, blockAlign);
    put16(fmt, bitsPerSample);
    if (extensible) {
        put16(fmt, 22);              // cbSize
        put16(fmt, bitsPerSample);   // valid bits
        put32(fmt, 0);               // channel mask
        put16(fmt, formatTag);       // SubFormat GUID: the real tag lives in its first two bytes
        for (int i = 0; i < 14; ++i) fmt.push_back(0);
    }

    std::vector<uint8_t> body;
    putTag(body, "WAVE");
    putTag(body, "fmt ");
    put32(body, static_cast<uint32_t>(fmt.size()));
    body.insert(body.end(), fmt.begin(), fmt.end());
    if (!extraChunk.empty()) body.insert(body.end(), extraChunk.begin(), extraChunk.end());
    putTag(body, "data");
    put32(body, static_cast<uint32_t>(audio.size()));
    body.insert(body.end(), audio.begin(), audio.end());
    if ((audio.size() & 1u) != 0) body.push_back(0);

    std::vector<uint8_t> file;
    putTag(file, "RIFF");
    put32(file, static_cast<uint32_t>(body.size()));
    file.insert(file.end(), body.begin(), body.end());
    return file;
}

void testWavCodec() {
    section("WAV reader and writer");

    std::string error;
    util::WavAudio audio;

    // ---- PCM16, stereo, exact endpoint values ----
    {
        // frame 0: L=0, R=+32767 ; frame 1: L=-32768, R=16384
        const std::vector<uint8_t> data = {0x00, 0x00, 0xFF, 0x7F, 0x00, 0x80, 0x00, 0x40};
        const std::vector<uint8_t> file = makeWav(1, 16, 2, 44100, data);
        check(util::parseWav(file.data(), file.size(), audio, error), "pcm16 stereo parses");
        checkEqual(audio.sourceFormat, "pcm16", "pcm16 is reported as such");
        check(audio.channels == 2 && audio.frames() == 2, "pcm16 frame and channel count");
        check(audio.sampleRate == 44100.0, "pcm16 sample rate");
        check(audio.samples[0][0] == 0.0f, "pcm16 zero maps to 0.0");
        check(audio.samples[1][0] == 32767.0f / 32768.0f, "pcm16 +full scale");
        check(audio.samples[0][1] == -1.0f, "pcm16 -32768 maps to -1.0");
        check(audio.samples[1][1] == 0.5f, "pcm16 half scale is exact");
    }

    // ---- PCM24, mono, sign extension ----
    {
        // +8388607 (max), -8388608 (min), 0
        const std::vector<uint8_t> data = {0xFF, 0xFF, 0x7F, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00};
        const std::vector<uint8_t> file = makeWav(1, 24, 1, 48000, data);
        check(util::parseWav(file.data(), file.size(), audio, error), "pcm24 mono parses");
        checkEqual(audio.sourceFormat, "pcm24", "pcm24 is reported as such");
        check(audio.channels == 1 && audio.frames() == 3, "pcm24 frame count");
        check(audio.samples[0][0] == 8388607.0f / 8388608.0f, "pcm24 +full scale");
        check(audio.samples[0][1] == -1.0f, "pcm24 sign extends to -1.0");
        check(audio.samples[0][2] == 0.0f, "pcm24 zero");
    }

    // ---- PCM32 ----
    {
        const std::vector<uint8_t> data = {0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x80};
        const std::vector<uint8_t> file = makeWav(1, 32, 1, 48000, data);
        check(util::parseWav(file.data(), file.size(), audio, error), "pcm32 parses");
        checkEqual(audio.sourceFormat, "pcm32", "pcm32 is reported as such");
        check(audio.samples[0][0] == 0.5f, "pcm32 half scale");
        check(audio.samples[0][1] == -1.0f, "pcm32 negative full scale");
    }

    // ---- float32, including WAVE_FORMAT_EXTENSIBLE and a foreign chunk in the middle ----
    {
        std::vector<std::vector<float>> channels = {{0.25f, -0.5f, 1.5f}, {0.0f, 1.0f, -1.0f}};
        std::vector<uint8_t> built;
        check(util::buildFloatWav(channels, 48000.0, built, error), "float32 WAV is built");
        check(util::parseWav(built.data(), built.size(), audio, error), "our own float WAV parses");
        checkEqual(audio.sourceFormat, "float32", "float32 is reported as such");
        check(audio.samples == channels, "float32 survives a write/read round trip bit exactly");
        check(audio.sampleRate == 48000.0, "float32 round trip keeps the sample rate");

        // "LIST" before the data chunk is normal in the wild; skipping it must not lose the audio.
        std::vector<uint8_t> list = {'L', 'I', 'S', 'T', 5, 0, 0, 0, 'I', 'N', 'F', 'O', 'x', 0};
        const std::vector<uint8_t> extensible =
            makeWav(3, 32, 2, 48000, std::vector<uint8_t>(built.end() - 24, built.end()), true,
                    list);
        check(util::parseWav(extensible.data(), extensible.size(), audio, error),
              "WAVE_FORMAT_EXTENSIBLE float with a LIST chunk parses");
        check(audio.frames() == 3, "an odd-sized foreign chunk is skipped with its pad byte");
    }

    // ---- rejections, each by name ----
    {
        const std::vector<uint8_t> aiff = {'F', 'O', 'R', 'M', 0, 0, 0, 4, 'A', 'I', 'F', 'F'};
        check(!util::parseWav(aiff.data(), aiff.size(), audio, error), "AIFF is refused");
        check(error.find("RIFF") != std::string::npos, "the AIFF error names RIFF");

        const std::vector<uint8_t> rf64 = {'R', 'F', '6', '4', 0, 0, 0, 4, 'W', 'A', 'V', 'E'};
        check(!util::parseWav(rf64.data(), rf64.size(), audio, error), "RF64 is refused");

        const std::vector<uint8_t> tiny = {'R', 'I', 'F', 'F'};
        check(!util::parseWav(tiny.data(), tiny.size(), audio, error), "a 4-byte file is refused");

        const std::vector<uint8_t> alaw = makeWav(6, 8, 1, 8000, {0x00, 0x01});
        check(!util::parseWav(alaw.data(), alaw.size(), audio, error), "a-law is refused");
        check(error.find("format tag") != std::string::npos, "the a-law error names the tag");

        const std::vector<uint8_t> f64 = makeWav(3, 64, 1, 48000, std::vector<uint8_t>(16, 0));
        check(!util::parseWav(f64.data(), f64.size(), audio, error), "64-bit float is refused");

        const std::vector<uint8_t> noData = {'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'A', 'V', 'E'};
        check(!util::parseWav(noData.data(), noData.size(), audio, error),
              "a WAVE with no fmt/data chunk is refused");
    }

    // ---- writer rejections ----
    {
        std::vector<uint8_t> out;
        check(!util::buildFloatWav({}, 48000.0, out, error), "a WAV with no channels is refused");
        check(!util::buildFloatWav({{0.0f, 1.0f}, {0.0f}}, 48000.0, out, error),
              "ragged channels are refused");
        check(!util::buildFloatWav({{0.0f}}, 0.0, out, error), "a zero sample rate is refused");
    }

    // ---- a truncated data chunk yields the frames that are really there ----
    {
        std::vector<uint8_t> file = makeWav(1, 16, 2, 48000, std::vector<uint8_t>(16, 0));
        file.resize(file.size() - 6);  // lose a frame and a half
        check(util::parseWav(file.data(), file.size(), audio, error),
              "a truncated data chunk still parses");
        check(audio.frames() == 2, "a partial trailing frame is dropped");
    }
}

}  // namespace

int runSelfTest() {
    gChecks = 0;
    gFailures = 0;
    std::printf("thedaw-vst-host self test\n\n");
    testSha1();
    testBase64();
    testJson();
    testAudioFrameHeader();
    testWebSocketFraming();
    testHandshake();
    testSpscQueue();
    testChannelMapAndDelay();
    testWavCodec();
    std::printf("\n%d checks, %d failures\n", gChecks, gFailures);
    std::fflush(stdout);
    return gFailures == 0 ? 0 : 1;
}

}  // namespace thedaw
