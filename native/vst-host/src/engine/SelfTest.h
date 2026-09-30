// --selftest: known-answer vectors for every codec the wire protocol depends on.
#pragma once

namespace thedaw {

// Prints a readable report to stdout. Returns 0 when everything passed, 1 otherwise.
int runSelfTest();

}  // namespace thedaw
