#include "WsServer.h"

#include <chrono>
#include <cstring>

#include "../util/Base64.h"
#include "../util/Log.h"
#include "../util/Sha1.h"
#include "../util/StringUtil.h"

namespace thedaw::net {
namespace {

using util::iequals;
using util::toLowerAscii;
using util::trim;

const char kWebSocketGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Timeout for writing the upgrade response: sending must not hang the acceptor.
constexpr int kHandshakeSendTimeoutMs = 5000;
// Total wall-clock budget for the whole handshake read loop (see
// handleIncoming): a client that connects and says nothing, or dribbles bytes
// slower than any single recv() would time out on, must not hold the single
// client slot -- and so the acceptor thread, which serves one connection at a
// time -- open past this.
constexpr int kHandshakeDeadlineMs = 2000;
// Shorter than the park timeout in Session.cpp (4000 ms): a peer that stops reading can
// stall a send, and a stalled send must never out-wait a park or the join in stop().
constexpr int kAudioSendTimeoutMs = 1000;

bool headerListContains(const std::string& value, const char* token) {
    const std::string needle = toLowerAscii(token);
    size_t begin = 0;
    while (begin <= value.size()) {
        size_t comma = value.find(',', begin);
        if (comma == std::string::npos) comma = value.size();
        const std::string item = toLowerAscii(trim(value.substr(begin, comma - begin)));
        if (item == needle) return true;
        begin = comma + 1;
    }
    return false;
}

void configureClientSocket(SOCKET socket) {
    BOOL nodelay = TRUE;
    setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay),
               sizeof(nodelay));
    // No receive timeout. The audio thread waits for data with WSAPoll and calls recv() only
    // on a readable socket (Session::audioLoop). A blocking recv() that times out through
    // SO_RCVTIMEO leaves a Windows socket "in an indeterminate state" (the setsockopt
    // documentation), and under CPU load such a timeout came back as error 997
    // (WSA_IO_PENDING) instead of WSAETIMEDOUT, which dropped a healthy client.
    // The handshake socket set one for the upgrade read; this puts it back to none.
    DWORD recvTimeout = 0;
    setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO,
               reinterpret_cast<const char*>(&recvTimeout), sizeof(recvTimeout));
    DWORD sendTimeout = kAudioSendTimeoutMs;
    setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO,
               reinterpret_cast<const char*>(&sendTimeout), sizeof(sendTimeout));
}

void closeGracefully(SOCKET socket) {
    if (socket == INVALID_SOCKET) return;
    shutdown(socket, SD_SEND);
    closesocket(socket);
}

}  // namespace

const std::string* HttpRequest::header(const char* name) const {
    for (const auto& entry : headers) {
        if (iequals(entry.first, name)) return &entry.second;
    }
    return nullptr;
}

bool parseHttpRequest(const std::string& text, HttpRequest& out, std::string& error) {
    out = HttpRequest();
    if (text.size() > kMaxHandshakeBytes) {
        error = "request headers too large";
        return false;
    }
    size_t lineStart = 0;
    const size_t firstBreak = text.find("\r\n");
    if (firstBreak == std::string::npos) {
        error = "malformed request line";
        return false;
    }
    const std::string requestLine = text.substr(0, firstBreak);
    const size_t firstSpace = requestLine.find(' ');
    const size_t secondSpace =
        firstSpace == std::string::npos ? std::string::npos
                                        : requestLine.find(' ', firstSpace + 1);
    if (firstSpace == std::string::npos || secondSpace == std::string::npos) {
        error = "malformed request line";
        return false;
    }
    out.method = requestLine.substr(0, firstSpace);
    out.target = requestLine.substr(firstSpace + 1, secondSpace - firstSpace - 1);
    out.version = requestLine.substr(secondSpace + 1);
    lineStart = firstBreak + 2;

    while (lineStart < text.size()) {
        const size_t lineEnd = text.find("\r\n", lineStart);
        if (lineEnd == std::string::npos) {
            error = "unterminated header";
            return false;
        }
        if (lineEnd == lineStart) break;  // end of headers
        const std::string line = text.substr(lineStart, lineEnd - lineStart);
        const size_t colon = line.find(':');
        if (colon == std::string::npos || colon == 0) {
            error = "malformed header line";
            return false;
        }
        if (out.headers.size() >= 64) {
            error = "too many headers";
            return false;
        }
        out.headers.emplace_back(trim(line.substr(0, colon)), trim(line.substr(colon + 1)));
        lineStart = lineEnd + 2;
    }
    return true;
}

bool originAllowed(const std::string& origin) {
    const std::string value = trim(origin);
    if (value.empty()) return true;               // header absent
    if (iequals(value, "null")) return true;      // sandboxed document

    const size_t colon = value.find(':');
    if (colon == std::string::npos || colon == 0) return false;  // not a serialized origin
    const std::string scheme = toLowerAscii(value.substr(0, colon));
    // file:// and custom schemes (Electron app://, tauri://, ...) are ours.
    if (scheme != "http" && scheme != "https") return true;

    std::string rest = value.substr(colon + 1);
    if (rest.rfind("//", 0) != 0) return false;
    rest = rest.substr(2);
    const size_t slash = rest.find('/');
    if (slash != std::string::npos) rest = rest.substr(0, slash);
    if (rest.find('@') != std::string::npos) return false;  // browsers never send userinfo

    std::string host;
    if (!rest.empty() && rest[0] == '[') {
        const size_t bracket = rest.find(']');
        if (bracket == std::string::npos) return false;
        host = rest.substr(0, bracket + 1);
    } else {
        const size_t portColon = rest.find(':');
        host = portColon == std::string::npos ? rest : rest.substr(0, portColon);
    }
    host = toLowerAscii(host);
    return host == "localhost" || host == "127.0.0.1" || host == "[::1]";
}

std::string computeAcceptKey(const std::string& secWebSocketKey) {
    const std::string combined = secWebSocketKey + kWebSocketGuid;
    uint8_t digest[20];
    util::sha1(combined.data(), combined.size(), digest);
    return util::base64Encode(digest, sizeof(digest));
}

HandshakeOutcome evaluateHandshake(const HttpRequest& request, bool busy,
                                   std::string& acceptKey, std::string& reason) {
    acceptKey.clear();
    reason.clear();

    if (!iequals(request.method, "GET")) {
        reason = "method is not GET";
        return HandshakeOutcome::BadRequest;
    }
    const std::string* upgrade = request.header("Upgrade");
    if (upgrade == nullptr || !iequals(trim(*upgrade), "websocket")) {
        reason = "missing Upgrade: websocket";
        return HandshakeOutcome::BadRequest;
    }
    const std::string* connection = request.header("Connection");
    if (connection == nullptr || !headerListContains(*connection, "upgrade")) {
        reason = "missing Connection: Upgrade";
        return HandshakeOutcome::BadRequest;
    }
    const std::string* key = request.header("Sec-WebSocket-Key");
    if (key == nullptr) {
        reason = "missing Sec-WebSocket-Key";
        return HandshakeOutcome::BadRequest;
    }
    std::vector<uint8_t> decodedKey;
    if (!util::base64Decode(trim(*key), decodedKey) || decodedKey.size() != 16) {
        reason = "Sec-WebSocket-Key is not 16 base64 bytes";
        return HandshakeOutcome::BadRequest;
    }
    const std::string* version = request.header("Sec-WebSocket-Version");
    if (version == nullptr || trim(*version) != "13") {
        reason = "Sec-WebSocket-Version must be 13";
        return HandshakeOutcome::UpgradeRequired;
    }

    const std::string* origin = request.header("Origin");
    if (origin != nullptr && !originAllowed(*origin)) {
        reason = "origin not allowed: " + *origin;
        return HandshakeOutcome::Forbidden;
    }

    // Origin is checked before the busy test so a hostile page is told 403,
    // never 409 (which would leak whether a session is live).
    if (busy) {
        reason = "another client is already connected";
        return HandshakeOutcome::Busy;
    }

    acceptKey = computeAcceptKey(trim(*key));
    return HandshakeOutcome::Accept;
}

std::string buildResponse(HandshakeOutcome outcome, const std::string& acceptKey) {
    switch (outcome) {
        case HandshakeOutcome::Accept:
            return "HTTP/1.1 101 Switching Protocols\r\n"
                   "Upgrade: websocket\r\n"
                   "Connection: Upgrade\r\n"
                   "Sec-WebSocket-Accept: " +
                   acceptKey + "\r\n\r\n";
        case HandshakeOutcome::Forbidden:
            return "HTTP/1.1 403 Forbidden\r\n"
                   "Content-Length: 0\r\n"
                   "Connection: close\r\n\r\n";
        case HandshakeOutcome::Busy:
            return "HTTP/1.1 409 Conflict\r\n"
                   "Content-Length: 0\r\n"
                   "Connection: close\r\n\r\n";
        case HandshakeOutcome::UpgradeRequired:
            return "HTTP/1.1 426 Upgrade Required\r\n"
                   "Sec-WebSocket-Version: 13\r\n"
                   "Content-Length: 0\r\n"
                   "Connection: close\r\n\r\n";
        case HandshakeOutcome::BadRequest:
        default:
            return "HTTP/1.1 400 Bad Request\r\n"
                   "Content-Length: 0\r\n"
                   "Connection: close\r\n\r\n";
    }
}

// ---------------------------------------------------------------------------

WinsockScope::~WinsockScope() {
    if (started_) WSACleanup();
}

bool WinsockScope::start(std::string& error) {
    if (started_) return true;
    WSADATA data{};
    const int result = WSAStartup(MAKEWORD(2, 2), &data);
    if (result != 0) {
        error = "WSAStartup failed with " + std::to_string(result);
        return false;
    }
    started_ = true;
    return true;
}

bool sendAll(SOCKET socket, const void* data, size_t size) {
    const char* bytes = static_cast<const char*>(data);
    size_t sent = 0;
    while (sent < size) {
        const int chunk = static_cast<int>(
            (size - sent) > 0x10000u ? 0x10000u : (size - sent));
        const int written = send(socket, bytes + sent, chunk, 0);
        if (written == SOCKET_ERROR) return false;
        if (written <= 0) return false;
        sent += static_cast<size_t>(written);
    }
    return true;
}

WsServer::~WsServer() { stop(); }

bool WsServer::start(int requestedPort, std::string& error) {
    listenSocket_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listenSocket_ == INVALID_SOCKET) {
        error = "socket() failed with " + std::to_string(WSAGetLastError());
        return false;
    }
    // No SO_REUSEADDR: on Windows it lets an unrelated process steal the port.
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(requestedPort));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);  // 127.0.0.1 only
    if (bind(listenSocket_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) ==
        SOCKET_ERROR) {
        error = "bind() failed with " + std::to_string(WSAGetLastError());
        closesocket(listenSocket_);
        listenSocket_ = INVALID_SOCKET;
        return false;
    }
    if (listen(listenSocket_, 4) == SOCKET_ERROR) {
        error = "listen() failed with " + std::to_string(WSAGetLastError());
        closesocket(listenSocket_);
        listenSocket_ = INVALID_SOCKET;
        return false;
    }
    sockaddr_in bound{};
    int boundSize = sizeof(bound);
    if (getsockname(listenSocket_, reinterpret_cast<sockaddr*>(&bound), &boundSize) ==
        SOCKET_ERROR) {
        error = "getsockname() failed with " + std::to_string(WSAGetLastError());
        closesocket(listenSocket_);
        listenSocket_ = INVALID_SOCKET;
        return false;
    }
    port_ = ntohs(bound.sin_port);

    acceptor_ = std::thread([this] { acceptorLoop(); });
    return true;
}

void WsServer::stop() {
    stopping_.store(true, std::memory_order_release);
    if (listenSocket_ != INVALID_SOCKET) {
        closesocket(listenSocket_);  // breaks the blocking accept()
        listenSocket_ = INVALID_SOCKET;
    }
    if (acceptor_.joinable()) acceptor_.join();
    const SOCKET pending = pendingClient_.exchange(INVALID_SOCKET);
    if (pending != INVALID_SOCKET) closeGracefully(pending);
    clientActive_.store(false, std::memory_order_release);
}

void WsServer::setOnClientConnected(ConnectedCallback callback, void* context) {
    onConnected_ = callback;
    onConnectedContext_ = context;
}

SOCKET WsServer::takeClient() { return pendingClient_.exchange(INVALID_SOCKET); }

void WsServer::releaseClient(SOCKET socket) {
    closeGracefully(socket);
    clientActive_.store(false, std::memory_order_release);
}

void WsServer::acceptorLoop() {
    util::setThreadTag("accept");
    while (!stopping_.load(std::memory_order_acquire)) {
        const SOCKET incoming = accept(listenSocket_, nullptr, nullptr);
        if (incoming == INVALID_SOCKET) {
            if (stopping_.load(std::memory_order_acquire)) break;
            const int code = WSAGetLastError();
            if (code == WSAEINTR || code == WSAECONNRESET) continue;
            util::log::writef("accept failed with %d; acceptor stopping", code);
            break;
        }
        handleIncoming(incoming);
    }
}

void WsServer::handleIncoming(SOCKET incoming) {
    DWORD sendTimeout = kHandshakeSendTimeoutMs;
    setsockopt(incoming, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&sendTimeout),
               sizeof(sendTimeout));

    // A TOTAL deadline across the whole loop below, not a per-recv timeout:
    // SO_RCVTIMEO only bounds a single recv() call, so a peer that sends a
    // byte just before each call's timeout fires could keep resetting it and
    // hold the acceptor (which handles one connection at a time) forever.
    // Every iteration re-arms SO_RCVTIMEO to whatever remains of this
    // deadline, so no single recv() can overrun it either.
    const auto handshakeDeadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(kHandshakeDeadlineMs);

    std::string request;
    request.reserve(1024);
    char chunk[1024];
    bool complete = false;
    while (request.size() < kMaxHandshakeBytes) {
        const auto remainingMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                      handshakeDeadline - std::chrono::steady_clock::now())
                                      .count();
        if (remainingMs <= 0) break;  // total deadline exceeded

        DWORD recvTimeout = static_cast<DWORD>(remainingMs);
        setsockopt(incoming, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&recvTimeout),
                   sizeof(recvTimeout));

        // Never read past kMaxHandshakeBytes: stop at exactly the cap instead
        // of overshooting it by up to one recv() chunk.
        const size_t room = kMaxHandshakeBytes - request.size();
        const int toRead = static_cast<int>(room < sizeof(chunk) ? room : sizeof(chunk));
        const int received = recv(incoming, chunk, toRead, 0);
        if (received <= 0) break;
        request.append(chunk, static_cast<size_t>(received));
        if (request.find("\r\n\r\n") != std::string::npos) {
            complete = true;
            break;
        }
    }
    if (!complete) {
        util::log::write("handshake: no complete request received");
        closeGracefully(incoming);
        return;
    }

    HttpRequest parsed;
    std::string parseError;
    HandshakeOutcome outcome = HandshakeOutcome::BadRequest;
    std::string acceptKey;
    std::string reason;

    // Claim the single client slot before evaluating so two simultaneous
    // connections cannot both be accepted.
    const bool wasActive = clientActive_.exchange(true, std::memory_order_acq_rel);

    if (!parseHttpRequest(request, parsed, parseError)) {
        reason = parseError;
        outcome = HandshakeOutcome::BadRequest;
    } else {
        outcome = evaluateHandshake(parsed, wasActive, acceptKey, reason);
    }

    const std::string response = buildResponse(outcome, acceptKey);
    sendAll(incoming, response.data(), response.size());

    if (outcome != HandshakeOutcome::Accept) {
        util::log::writef("handshake refused (%s)", reason.c_str());
        // Only give the slot back if this connection is the one that claimed it.
        if (!wasActive) clientActive_.store(false, std::memory_order_release);
        closeGracefully(incoming);
        return;
    }

    configureClientSocket(incoming);
    if (onConnected_ != nullptr) onConnected_(onConnectedContext_);
    const SOCKET previous = pendingClient_.exchange(incoming);
    if (previous != INVALID_SOCKET) closeGracefully(previous);
    util::log::write("client connected");
}

}  // namespace thedaw::net
