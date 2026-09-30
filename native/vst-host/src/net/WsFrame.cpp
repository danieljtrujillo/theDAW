#include "WsFrame.h"

#include <cstring>

namespace thedaw::net {

bool isControlOpcode(Opcode opcode) {
    return (static_cast<uint8_t>(opcode) & 0x08u) != 0;
}

bool isKnownOpcode(uint8_t raw) {
    switch (raw) {
        case 0x0:
        case 0x1:
        case 0x2:
        case 0x8:
        case 0x9:
        case 0xA:
            return true;
        default:
            return false;
    }
}

HeaderStatus parseFrameHeader(const uint8_t* data, size_t size, FrameHeader& out,
                              const char** error) {
    if (size < 2) return HeaderStatus::Incomplete;

    const uint8_t byte0 = data[0];
    const uint8_t byte1 = data[1];

    out.fin = (byte0 & 0x80u) != 0;
    out.rsv = (byte0 & 0x70u) != 0;
    const uint8_t rawOpcode = static_cast<uint8_t>(byte0 & 0x0Fu);
    out.masked = (byte1 & 0x80u) != 0;

    if (out.rsv) {
        *error = "reserved bits must be zero";
        return HeaderStatus::ProtocolError;
    }
    if (!isKnownOpcode(rawOpcode)) {
        *error = "unknown opcode";
        return HeaderStatus::ProtocolError;
    }
    out.opcode = static_cast<Opcode>(rawOpcode);

    const uint8_t shortLength = static_cast<uint8_t>(byte1 & 0x7Fu);
    size_t offset = 2;
    if (shortLength < 126) {
        out.payloadLength = shortLength;
    } else if (shortLength == 126) {
        if (size < 4) return HeaderStatus::Incomplete;
        out.payloadLength = (static_cast<uint64_t>(data[2]) << 8) | data[3];
        if (out.payloadLength < 126) {
            *error = "16-bit length must not be minimally encodable";
            return HeaderStatus::ProtocolError;
        }
        offset = 4;
    } else {
        if (size < 10) return HeaderStatus::Incomplete;
        uint64_t length = 0;
        for (int i = 0; i < 8; ++i) {
            length = (length << 8) | data[2 + i];
        }
        if ((length & 0x8000000000000000ull) != 0) {
            *error = "64-bit length must have the high bit clear";
            return HeaderStatus::ProtocolError;
        }
        if (length < 65536) {
            *error = "64-bit length must not be minimally encodable";
            return HeaderStatus::ProtocolError;
        }
        out.payloadLength = length;
        offset = 10;
    }

    if (isControlOpcode(out.opcode)) {
        if (!out.fin) {
            *error = "fragmented control frame";
            return HeaderStatus::ProtocolError;
        }
        if (out.payloadLength > kMaxControlPayload) {
            *error = "control frame payload over 125 bytes";
            return HeaderStatus::ProtocolError;
        }
    }
    if (out.payloadLength > kMaxMessageBytes) {
        *error = "frame larger than the 8 MB limit";
        return HeaderStatus::TooBig;
    }

    if (out.masked) {
        if (size < offset + 4) return HeaderStatus::Incomplete;
        std::memcpy(out.mask, data + offset, 4);
        offset += 4;
    } else {
        std::memset(out.mask, 0, sizeof(out.mask));
    }

    out.headerSize = offset;
    return HeaderStatus::Ok;
}

void applyMask(uint8_t* data, size_t size, const uint8_t mask[4]) {
    for (size_t i = 0; i < size; ++i) {
        data[i] = static_cast<uint8_t>(data[i] ^ mask[i & 3u]);
    }
}

size_t writeFrameHeader(uint8_t* out, Opcode opcode, bool fin, uint64_t payloadLength) {
    out[0] = static_cast<uint8_t>((fin ? 0x80u : 0x00u) |
                                  (static_cast<uint8_t>(opcode) & 0x0Fu));
    if (payloadLength < 126) {
        out[1] = static_cast<uint8_t>(payloadLength);
        return 2;
    }
    if (payloadLength < 65536) {
        out[1] = 126;
        out[2] = static_cast<uint8_t>((payloadLength >> 8) & 0xFFu);
        out[3] = static_cast<uint8_t>(payloadLength & 0xFFu);
        return 4;
    }
    out[1] = 127;
    for (int i = 0; i < 8; ++i) {
        out[2 + i] = static_cast<uint8_t>((payloadLength >> (56 - i * 8)) & 0xFFu);
    }
    return 10;
}

std::vector<uint8_t> buildClientFrame(Opcode opcode, bool fin, const uint8_t* payload,
                                      size_t size, const uint8_t mask[4]) {
    uint8_t header[10];
    const size_t headerSize = writeFrameHeader(header, opcode, fin, size);
    std::vector<uint8_t> out;
    out.reserve(headerSize + 4 + size);
    out.insert(out.end(), header, header + headerSize);
    out[1] = static_cast<uint8_t>(out[1] | 0x80u);  // MASK
    out.insert(out.end(), mask, mask + 4);
    const size_t payloadStart = out.size();
    if (size > 0) out.insert(out.end(), payload, payload + size);
    applyMask(out.data() + payloadStart, size, mask);
    return out;
}

void FrameReader::reserve(size_t bytes) {
    if (buffer_.size() < bytes) buffer_.resize(bytes);
    if (assembly_.capacity() < bytes) assembly_.reserve(bytes);
}

void FrameReader::reset() {
    start_ = 0;
    end_ = 0;
    assembly_.clear();
    assembling_ = false;
    closeCode_ = kCloseProtocolError;
    error_ = "";
}

bool FrameReader::ensureSpace(size_t wanted) {
    if (buffer_.size() - end_ >= wanted) return true;
    if (start_ > 0) {
        std::memmove(buffer_.data(), buffer_.data() + start_, end_ - start_);
        end_ -= start_;
        start_ = 0;
    }
    if (buffer_.size() - end_ >= wanted) return true;
    const size_t needed = end_ + wanted;
    // Hard ceiling: header (14) + the largest message we ever accept.
    if (needed > kMaxMessageBytes + 64) return false;
    buffer_.resize(needed);
    return true;
}

uint8_t* FrameReader::writePointer(size_t& space) {
    if (buffer_.empty()) buffer_.resize(64 * 1024);
    if (start_ == end_) {
        start_ = 0;
        end_ = 0;
    }
    if (buffer_.size() - end_ < 4096) {
        if (!ensureSpace(4096)) {
            space = 0;
            return nullptr;
        }
    }
    space = buffer_.size() - end_;
    return buffer_.data() + end_;
}

void FrameReader::commitWrite(size_t bytes) { end_ += bytes; }

FrameReader::Status FrameReader::next(Message& out) {
    for (;;) {
        const size_t available = end_ - start_;
        if (available < 2) return Status::NeedMore;

        FrameHeader header;
        const char* error = "";
        const HeaderStatus status =
            parseFrameHeader(buffer_.data() + start_, available, header, &error);
        if (status == HeaderStatus::Incomplete) return Status::NeedMore;
        if (status == HeaderStatus::ProtocolError) {
            error_ = error;
            closeCode_ = kCloseProtocolError;
            return Status::ProtocolError;
        }
        if (status == HeaderStatus::TooBig) {
            error_ = error;
            closeCode_ = kCloseTooBig;
            return Status::MessageTooBig;
        }
        if (!header.masked) {
            error_ = "client frames must be masked";
            closeCode_ = kCloseProtocolError;
            return Status::ProtocolError;
        }

        const size_t frameSize = header.headerSize + static_cast<size_t>(header.payloadLength);
        if (available < frameSize) {
            // Ask for exactly what is still missing from THIS frame. ensureSpace
            // wants "bytes of free space beyond end_", so passing frameSize
            // itself here would demand room for frameSize MORE bytes on top of
            // the `available` already buffered -- comparing the cumulative
            // buffer end against the ceiling instead of this frame's actual
            // size, and spuriously closing a legitimate maximum-size message
            // with 1009 once available + frameSize crossed kMaxMessageBytes.
            if (!ensureSpace(frameSize - available)) {
                error_ = "frame larger than the 8 MB limit";
                closeCode_ = kCloseTooBig;
                return Status::MessageTooBig;
            }
            return Status::NeedMore;
        }

        uint8_t* payload = buffer_.data() + start_ + header.headerSize;
        const size_t payloadSize = static_cast<size_t>(header.payloadLength);
        applyMask(payload, payloadSize, header.mask);
        start_ += frameSize;

        if (isControlOpcode(header.opcode)) {
            out.opcode = header.opcode;
            out.data = payload;
            out.size = payloadSize;
            return Status::Message;
        }

        if (header.opcode == Opcode::Continuation) {
            if (!assembling_) {
                error_ = "continuation frame without a start frame";
                closeCode_ = kCloseProtocolError;
                return Status::ProtocolError;
            }
            if (assembly_.size() + payloadSize > kMaxMessageBytes) {
                error_ = "message larger than the 8 MB limit";
                closeCode_ = kCloseTooBig;
                return Status::MessageTooBig;
            }
            assembly_.insert(assembly_.end(), payload, payload + payloadSize);
            if (!header.fin) continue;
            assembling_ = false;
            out.opcode = assemblyOpcode_;
            out.data = assembly_.data();
            out.size = assembly_.size();
            return Status::Message;
        }

        // Text or Binary: the start of a message.
        if (assembling_) {
            error_ = "new data frame while a fragmented message is open";
            closeCode_ = kCloseProtocolError;
            return Status::ProtocolError;
        }
        if (header.fin) {
            out.opcode = header.opcode;
            out.data = payload;
            out.size = payloadSize;
            return Status::Message;
        }
        assembling_ = true;
        assemblyOpcode_ = header.opcode;
        assembly_.clear();
        if (payloadSize > kMaxMessageBytes) {
            error_ = "message larger than the 8 MB limit";
            closeCode_ = kCloseTooBig;
            return Status::MessageTooBig;
        }
        assembly_.insert(assembly_.end(), payload, payload + payloadSize);
    }
}

}  // namespace thedaw::net
