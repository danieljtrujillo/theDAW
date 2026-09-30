// Offline rendering: the same host, the same plugin layer and the same state container as the
// live session, driven from a file instead of a socket.
//
// Why it lives in the host at all: a chain entry's `raw_state` has to mean the same thing live
// and on export. Two different hosts cannot guarantee that (see the state notes in
// docs/design/vst-live-protocol.md), so the offline path runs through this program.
//
// Everything here is message-thread-adjacent rather than realtime: the plugin is prepared with
// PrepareConfig::offline, processing runs on a worker thread as fast as it can, and the Win32
// message loop keeps pumping so restart requests and other plugin callbacks are serviced.
#pragma once

#include "../util/Args.h"

namespace thedaw {

class MessageLoop;

// Runs a `--render` invocation to completion and prints its JSON report to stdout.
// Returns the process exit code (see usageText(): 0 clean, 1 unwritable output, 3/4/5 plugin,
// 7 unreadable input).
int runRender(const Options& options, MessageLoop& loop);

}  // namespace thedaw
