// Command line per docs/design/vst-live-protocol.md ("Host command line").
#pragma once

#include <string>
#include <vector>

namespace thedaw {

enum class RunMode { Serve, Render, List, SelfTest, Help, Version };

struct Options {
    RunMode mode = RunMode::Serve;

    std::wstring pluginPath;
    std::string pluginName;  // selector inside a multi-plugin bundle
    std::string classId;     // 32 hex chars
    bool nullPlugin = false;

    double sampleRate = 48000.0;
    int blockSize = 512;
    int channels = 2;

    std::wstring stateFile;
    std::wstring logFile;

    int port = 0;             // 0 = OS assigned
    int idleTimeoutSec = 0;   // 0 = never
    unsigned parentPid = 0;   // 0 = no watchdog

    // ---- --render (offline) ----
    std::wstring inputPath;
    std::wstring outputPath;
    // Inline JSON when it starts with '{' or '[', otherwise the path of a JSON file.
    std::wstring paramsJson;
    // A text file of MIDI messages the plugin plays during the render, one per line:
    // "<sample frame> <status> <data1> [<data2>]", decimal. For an instrument.
    std::wstring midiEvents;
    // A JSON file of parameter automation the render applies block by block: an array of
    // {"index": N, "name": "...", "points": [[frame, value], ...]}, each a piecewise-linear curve
    // of a normalized value over the input's sample frames. For an automated insert.
    std::wstring automationJson;
    // < 0 = "auto": the plugin's reported tail, capped at kRenderTailCapSeconds, with an
    // infinite tail becoming kRenderInfiniteTailSeconds.
    double tailSeconds = -1.0;
    // What IHostApplication::getName() reports. Empty = the host's own default.
    std::string hostName;
    // Record every interface the plugin asks our host objects for, and print the list.
    bool iidLog = false;
};

// "auto" tail policy, shared by the renderer and its documentation.
inline constexpr double kRenderTailCapSeconds = 30.0;
inline constexpr double kRenderInfiniteTailSeconds = 10.0;

// Returns false with a human-readable `error` for anything the host would have
// to guess about; the caller exits 2.
bool parseArgs(const std::vector<std::wstring>& argv, Options& out, std::string& error);

const char* usageText();

}  // namespace thedaw
