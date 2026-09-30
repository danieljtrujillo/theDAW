// Our own RFC 6455 server over Winsock: loopback only, no TLS, no extensions,
// one client at a time.
//
// The acceptor thread performs the HTTP upgrade and then hands the socket to the
// audio thread, which owns all reads and writes for the life of the connection.
#pragma once

#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace thedaw::net {

// How long the audio thread waits for the client's next bytes before it goes round its loop
// again; this also bounds how long a park request waits and how long a queued reply sits.
inline constexpr int kAudioPollTimeoutMs = 2;

// ---- handshake pieces (exposed so --selftest can exercise them directly) ----

struct HttpRequest {
    std::string method;
    std::string target;
    std::string version;
    std::vector<std::pair<std::string, std::string>> headers;

    const std::string* header(const char* name) const;
};

inline constexpr size_t kMaxHandshakeBytes = 16 * 1024;

bool parseHttpRequest(const std::string& text, HttpRequest& out, std::string& error);

// Accepts: no Origin, "null", file:// and any non-http(s) scheme (Electron
// app://, custom protocols). Rejects every other http(s) origin, which is what
// stops a random web page from driving the user's plugins.
bool originAllowed(const std::string& origin);

std::string computeAcceptKey(const std::string& secWebSocketKey);

enum class HandshakeOutcome { Accept, BadRequest, Forbidden, Busy, UpgradeRequired };

HandshakeOutcome evaluateHandshake(const HttpRequest& request, bool busy,
                                   std::string& acceptKey, std::string& reason);

std::string buildResponse(HandshakeOutcome outcome, const std::string& acceptKey);

// ---- the server ----

class WsServer {
public:
    using ConnectedCallback = void (*)(void* context);

    WsServer() = default;
    ~WsServer();
    WsServer(const WsServer&) = delete;
    WsServer& operator=(const WsServer&) = delete;

    // Binds 127.0.0.1:<port> (0 = OS assigned), listens, and starts accepting.
    bool start(int requestedPort, std::string& error);
    void stop();

    int port() const { return port_; }

    void setOnClientConnected(ConnectedCallback callback, void* context);

    // AUDIO THREAD: picks up a socket that finished its handshake.
    SOCKET takeClient();
    // AUDIO THREAD: the connection ended; closes it and re-arms the acceptor.
    void releaseClient(SOCKET socket);

    bool hasClient() const { return clientActive_.load(std::memory_order_acquire); }

private:
    void acceptorLoop();
    void handleIncoming(SOCKET socket);

    SOCKET listenSocket_ = INVALID_SOCKET;
    std::atomic<SOCKET> pendingClient_{INVALID_SOCKET};
    std::atomic<bool> clientActive_{false};
    std::atomic<bool> stopping_{false};
    std::thread acceptor_;
    int port_ = 0;
    ConnectedCallback onConnected_ = nullptr;
    void* onConnectedContext_ = nullptr;
};

// Process-wide Winsock lifetime.
class WinsockScope {
public:
    WinsockScope() = default;
    ~WinsockScope();
    WinsockScope(const WinsockScope&) = delete;
    WinsockScope& operator=(const WinsockScope&) = delete;

    bool start(std::string& error);

private:
    bool started_ = false;
};

// Blocking send of the whole buffer; false when the peer is gone or stalled.
bool sendAll(SOCKET socket, const void* data, size_t size);

}  // namespace thedaw::net
