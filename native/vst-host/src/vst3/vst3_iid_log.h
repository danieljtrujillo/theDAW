// A record of every interface a plugin asks OUR objects for.
//
// Why this exists: two hosts that offer a different set of host-side interfaces can get
// different bytes out of the same plugin's getState(). Before guessing which interface matters,
// measure — this records each queryInterface a plugin makes against the host context, the
// component handler, the attribute/message bags, the state streams and the plug frame, together
// with whether we answered it. The unanswered entries are the list of things this host does not
// speak, in the order a real plugin asked for them.
//
// Not on the audio path: the instrumented objects are all message-thread objects. The parameter
// queues handed to process() are deliberately NOT instrumented, so nothing here can take a lock
// inside a process call.
#pragma once

#include <string>
#include <vector>

#include "pluginterfaces/base/funknown.h"

namespace thedaw::vst3::iidlog {

struct Entry {
    std::string site;   // which of our objects was asked: "host_context", "stream", ...
    std::string iid;    // 32 hex characters, the same spelling PluginInfo::identifier uses
    std::string name;   // the interface's SDK name when we know it, otherwise empty
    bool answered = false;
    long long count = 0;
};

// Recording is off until enabled, so a normal live session pays nothing but one relaxed load.
void setEnabled(bool on);
bool enabled();

// Called from every instrumented queryInterface. Coalesces repeats into `count`.
void record(const char* site, const Steinberg::TUID wantedIid, bool answered);

// Every distinct (site, iid) seen so far, in first-seen order.
std::vector<Entry> entries();
void clear();

// 32 uppercase hex characters for an arbitrary TUID (no interface knowledge needed).
std::string iidToHex(const Steinberg::TUID iid);

// The SDK name of a known interface, or "" — exposed so callers can label an id they hold.
std::string iidName(const Steinberg::TUID iid);

// Records `result` and hands it straight back, so an instrumented queryInterface stays one line:
//   return iidlog::seen("host_context", wantedIid, queryInterfaceInner(wantedIid, obj));
inline Steinberg::tresult seen(const char* site, const Steinberg::TUID wantedIid,
                               Steinberg::tresult result) {
    if (enabled()) record(site, wantedIid, result == Steinberg::kResultOk);
    return result;
}

}  // namespace thedaw::vst3::iidlog
