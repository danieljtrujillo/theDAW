// RFC 6455 frame codec and message reassembler.
//
// Everything here runs on the audio thread, so FrameReader preallocates its
// buffers in reserve() and never allocates again for messages that fit -- which
// every audio block does by construction (the engine reserves for
// maxBlockSize x 8 channels). Only an unusually large control message (a big
// set_state blob) can force a one-off grow, and set_state parks audio anyway.
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace thedaw::net {

inline constexpr uint64_t kMaxMessageBytes = 8ull * 1024ull * 1024ull;
inline constexpr size_t kMaxControlPayload = 125;

// Close codes used by this server (RFC 6455 section 7.4.1).
inline constexpr uint16_t kCloseNormal = 1000;
inline constexpr uint16_t kCloseGoingAway = 1001;
inline constexpr uint16_t kCloseProtocolError = 1002;
inline constexpr uint16_t kCloseTooBig = 1009;
inline constexpr uint16_t kCloseInternalError = 1011;

enum class Opcode : uint8_t {
    Continuation = 0x0,
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA,
};

bool isControlOpcode(Opcode opcode);
bool isKnownOpcode(uint8_t raw);

struct FrameHeader {
    bool fin = false;
    bool rsv = false;  // true when any reserved bit is set (no extensions here)
    Opcode opcode = Opcode::Continuation;
    bool masked = false;
    uint64_t payloadLength = 0;
    uint8_t mask[4] = {0, 0, 0, 0};
    size_t headerSize = 0;
};

enum class HeaderStatus { Incomplete, Ok, ProtocolError, TooBig };

// Parses only the header; `size` is what is currently buffered.
HeaderStatus parseFrameHeader(const uint8_t* data, size_t size, FrameHeader& out,
                              const char** error);

void applyMask(uint8_t* data, size_t size, const uint8_t mask[4]);

// Writes an unmasked server-side header (servers never mask). `out` needs 10
// bytes; returns how many were written.
size_t writeFrameHeader(uint8_t* out, Opcode opcode, bool fin, uint64_t payloadLength);

// Builds a complete masked client frame. Used by the self-test to drive the
// reader with the same bytes a browser would send.
std::vector<uint8_t> buildClientFrame(Opcode opcode, bool fin, const uint8_t* payload,
                                      size_t size, const uint8_t mask[4]);

// Reassembles frames into messages. Not thread safe; one instance per client.
class FrameReader {
public:
    struct Message {
        Opcode opcode = Opcode::Text;
        const uint8_t* data = nullptr;  // valid until the next call
        size_t size = 0;
    };

    enum class Status { NeedMore, Message, ProtocolError, MessageTooBig };

    void reserve(size_t bytes);
    void reset();

    // Where recv() should write, and how much room there is.
    uint8_t* writePointer(size_t& space);
    void commitWrite(size_t bytes);

    Status next(Message& out);

    uint16_t closeCode() const { return closeCode_; }
    const char* errorText() const { return error_; }

private:
    bool ensureSpace(size_t wanted);

    std::vector<uint8_t> buffer_;
    size_t start_ = 0;
    size_t end_ = 0;

    std::vector<uint8_t> assembly_;
    bool assembling_ = false;
    Opcode assemblyOpcode_ = Opcode::Text;

    uint16_t closeCode_ = kCloseProtocolError;
    const char* error_ = "";
};

}  // namespace thedaw::net
