#include "WsSelfTest.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "WsFrame.h"
#include "WsServer.h"

namespace thedaw::net {
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

void section(const char* name) { std::printf("%s\n", name); }

// Feeds bytes through FrameReader the way the audio thread does: a run of
// writePointer()/commitWrite() calls, exactly as small a chunk at a time as
// the reader currently offers.
bool feed(FrameReader& reader, const std::vector<uint8_t>& bytes) {
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

SOCKET connectLoopback(int port) {
    SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET) return INVALID_SOCKET;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) {
        closesocket(client);
        return INVALID_SOCKET;
    }
    return client;
}

// Sends a well-formed upgrade request and reports whether the response is a
// 101 Switching Protocols line, arriving within timeoutMs.
bool performHandshake(SOCKET client, DWORD timeoutMs) {
    const std::string request =
        "GET /live HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n";
    if (!sendAll(client, request.data(), request.size())) return false;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeoutMs),
               sizeof(timeoutMs));
    char buffer[256];
    const int received = recv(client, buffer, sizeof(buffer) - 1, 0);
    if (received <= 0) return false;
    buffer[received] = '\0';
    return std::strncmp(buffer, "HTTP/1.1 101", 12) == 0;
}

// ---------------------------------------------------------------------------

void testHandshakeDeadlineFreesTheAcceptor() {
    section("handshake deadline frees the single acceptor");
    WsServer server;
    std::string error;
    const bool started = server.start(0, error);
    check(started, "server starts on an OS-assigned loopback port");
    if (!started) return;
    const int port = server.port();

    SOCKET slow = connectLoopback(port);
    check(slow != INVALID_SOCKET, "the slow client connects");
    if (slow != INVALID_SOCKET) {
        // Dribble one byte every 100 ms for ~2.8 s: comfortably past the ~2 s
        // deadline. None of this ever spells "\r\n\r\n", so only the deadline --
        // not a completed request -- can end the handshake.
        for (int i = 0; i < 28; ++i) {
            const char byte = 'x';
            send(slow, &byte, 1, 0);
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }

    // The single acceptor thread must be back at accept() by now: a second
    // client can connect and its handshake must complete quickly, not just sit
    // queued behind a first connection that is still (mis)holding the acceptor.
    // The bound here (1.5 s) is deliberately shorter than the per-recv timeout
    // the old, un-deadlined code would need to time out on its own -- a hung
    // acceptor must fail this check, not eventually pass it by coincidence.
    SOCKET second = connectLoopback(port);
    check(second != INVALID_SOCKET, "a second client can connect once the deadline passes");
    if (second != INVALID_SOCKET) {
        check(performHandshake(second, 1500),
              "and the second client's handshake completes promptly (the acceptor was not stuck)");
        closesocket(second);
    }

    if (slow != INVALID_SOCKET) closesocket(slow);
    server.stop();
}

void testMaxMessageBoundary() {
    section("max-message guard compares this frame's size, not the buffer end");
    {
        FrameReader reader;
        reader.reserve(64 * 1024);  // far smaller than the message: growth must happen mid-frame
        std::vector<uint8_t> payload(static_cast<size_t>(kMaxMessageBytes), 0xAB);
        const uint8_t mask[4] = {0x11, 0x22, 0x33, 0x44};
        const std::vector<uint8_t> frame =
            buildClientFrame(Opcode::Binary, true, payload.data(), payload.size(), mask);
        const size_t half = frame.size() / 2;

        check(feed(reader, std::vector<uint8_t>(frame.begin(), frame.begin() + half)),
              "feeds the first half of a maximum-size (8 MB) message");
        FrameReader::Message message;
        check(reader.next(message) == FrameReader::Status::NeedMore,
              "half a frame is not a message yet, and does not trip the size guard");
        check(feed(reader, std::vector<uint8_t>(frame.begin() + half, frame.end())),
              "feeds the second half");
        check(reader.next(message) == FrameReader::Status::Message,
              "a legitimate maximum-size message is accepted, not closed with 1009");
        check(message.opcode == Opcode::Binary && message.size == payload.size(),
              "the full 8 MB payload arrives intact");
    }
    {
        FrameReader reader;
        reader.reserve(4096);
        // A 64-bit length header declaring kMaxMessageBytes + 1; no payload bytes
        // are needed because the guard rejects it from the declared length alone.
        uint8_t header[14];
        const size_t headerSize =
            writeFrameHeader(header, Opcode::Binary, /*fin=*/true, kMaxMessageBytes + 1);
        check(headerSize == 10, "8 MB + 1 needs a 64-bit length field");
        header[1] = static_cast<uint8_t>(header[1] | 0x80u);  // MASK bit
        const uint8_t maskBytes[4] = {0, 0, 0, 0};
        std::vector<uint8_t> bytes(header, header + headerSize);
        bytes.insert(bytes.end(), maskBytes, maskBytes + 4);

        check(feed(reader, bytes), "feeds a header declaring one byte over the limit");
        FrameReader::Message message;
        check(reader.next(message) == FrameReader::Status::MessageTooBig,
              "one byte over the 8 MB limit is rejected");
        check(reader.closeCode() == kCloseTooBig, "close code 1009");
    }
}

void testOversizedHandshakeIsRefused() {
    section("a handshake over kMaxHandshakeBytes is refused, not accepted late");
    WsServer server;
    std::string error;
    const bool started = server.start(0, error);
    check(started, "server starts on an OS-assigned loopback port");
    if (!started) return;
    const int port = server.port();

    SOCKET client = connectLoopback(port);
    check(client != INVALID_SOCKET, "the client connects");
    if (client != INVALID_SOCKET) {
        // One byte over the cap, and never a "\r\n\r\n" terminator: this must be
        // refused for being oversized, not accepted once enough of it arrives.
        const std::string oversized(static_cast<size_t>(kMaxHandshakeBytes) + 1, 'a');
        check(sendAll(client, oversized.data(), oversized.size()), "sends the oversized request");

        DWORD recvTimeout = 5000;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&recvTimeout),
                   sizeof(recvTimeout));
        char buffer[64];
        const int received = recv(client, buffer, sizeof(buffer), 0);
        check(received <= 0, "the connection is dropped rather than upgraded");
        closesocket(client);
    }

    // The acceptor must still be free for a well-formed client afterwards.
    SOCKET second = connectLoopback(port);
    check(second != INVALID_SOCKET, "a further client can still connect");
    if (second != INVALID_SOCKET) {
        check(performHandshake(second, 2000), "and complete a normal handshake");
        closesocket(second);
    }
    server.stop();
}

}  // namespace

int runWsHardeningSelfTest() {
    gChecks = 0;
    gFailures = 0;
    std::printf("thedaw-vst-host WebSocket hardening self test\n\n");

    WinsockScope winsock;
    std::string wsaError;
    if (!winsock.start(wsaError)) {
        ++gChecks;
        ++gFailures;
        std::printf("  FAIL  WSAStartup: %s\n", wsaError.c_str());
    } else {
        testHandshakeDeadlineFreesTheAcceptor();
        testMaxMessageBoundary();
        testOversizedHandshakeIsRefused();
    }

    std::printf("\n%d checks, %d failures\n", gChecks, gFailures);
    std::fflush(stdout);
    return gFailures;
}

}  // namespace thedaw::net
