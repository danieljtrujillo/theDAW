// --selftest hardening vectors for the WebSocket layer (ticket F4b): the total
// handshake deadline, the exact kMaxHandshakeBytes cap, and the max-message
// boundary. See engine/SelfTest.h for the general RFC 6455 framing and
// handshake-evaluation self test; this file covers only the hardening fixes.
#pragma once

namespace thedaw::net {

// Prints a readable report to stdout. Returns the number of failed checks (0
// when everything passed).
int runWsHardeningSelfTest();

}  // namespace thedaw::net
