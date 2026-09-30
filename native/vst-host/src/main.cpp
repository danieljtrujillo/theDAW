// thedaw-vst-host entry point.
//
// See docs/design/vst-live-protocol.md for the command line, the wire protocol
// and the exit codes. Everything this process does is local: it binds 127.0.0.1
// only and never opens an outbound connection.

#include <windows.h>

#include <shellapi.h>

#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "engine/MessageLoop.h"
#include "engine/Render.h"
#include "engine/SelfTest.h"
#include "engine/Session.h"
#include "net/WsSelfTest.h"
#include "plugin/IPluginInstance.h"
#include "util/Args.h"
#include "util/AtomicFile.h"
#include "util/Json.h"
#include "util/Log.h"
#include "util/StringUtil.h"

#ifndef THEDAW_VST3_ENABLED
#define THEDAW_VST3_ENABLED 0
#endif

namespace {

constexpr const char* kHostVersion = "1.0.0";

constexpr int kExitOk = 0;
constexpr int kExitBadArgs = 2;
constexpr int kExitPluginMissing = 3;
constexpr int kExitPluginFailed = 4;

void printLine(const std::string& text) {
    std::fputs(text.c_str(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void printVersion() {
    thedaw::json::Writer writer;
    writer.beginObject()
        .strField("name", "thedaw-vst-host")
        .strField("version", kHostVersion)
        .intField("protocol", 1)
        .boolField("vst3", THEDAW_VST3_ENABLED != 0)
        .strField("build", __DATE__ " " __TIME__)
        .endObject();
    printLine(writer.text());
}

int runList(const thedaw::Options& options) {
    const thedaw::PluginListing listing =
        thedaw::listVst3Plugins(thedaw::util::wideToUtf8(options.pluginPath));
    if (!listing.ok) {
        thedaw::json::Writer writer;
        writer.beginObject()
            .strField("ev", "error")
            .strField("text", listing.error)
            .boolField("fatal", true)
            .endObject();
        printLine(writer.text());
        std::fputs((listing.error + "\n").c_str(), stderr);
        std::fflush(stderr);
        return listing.exitCodeHint != 0 ? listing.exitCodeHint : kExitPluginFailed;
    }
    thedaw::json::Writer writer;
    writer.beginArray();
    for (const thedaw::PluginInfo& info : listing.plugins) {
        writer.beginObject()
            .strField("name", info.name)
            .strField("vendor", info.vendor)
            .strField("version", info.version)
            .strField("category", info.category)
            .strField("identifier", info.identifier)
            .strField("format", info.format)
            .endObject();
    }
    writer.endArray();
    printLine(writer.text());
    return kExitOk;
}

// Reads line-delimited JSON from stdin; {"op":"shutdown"} or EOF exits cleanly.
// Detached: it only touches process-lifetime globals, never the Session.
void stdinWatcher() {
    thedaw::util::setThreadTag("stdin");
    std::string line;
    for (;;) {
        const int c = std::fgetc(stdin);
        if (c == EOF) {
            thedaw::util::log::write("stdin reached EOF; shutting down");
            thedaw::postHostQuit(kExitOk);
            return;
        }
        if (c != '\n') {
            if (c != '\r' && line.size() < 4096) line.push_back(static_cast<char>(c));
            continue;
        }
        const std::string text = thedaw::util::trim(line);
        line.clear();
        if (text.empty()) continue;
        thedaw::json::Value message;
        std::string error;
        if (!thedaw::json::parse(text, message, error)) {
            thedaw::util::log::writef("ignoring malformed stdin line: %s", error.c_str());
            continue;
        }
        const std::string op = message.stringOr("op", "");
        if (op == "shutdown") {
            thedaw::util::log::write("shutdown requested on stdin");
            thedaw::postHostQuit(kExitOk);
            return;
        }
        thedaw::util::log::writef("ignoring unknown stdin op \"%s\"", op.c_str());
    }
}

// Exits when the spawning process disappears. Detached for the same reason.
void parentWatcher(unsigned parentPid) {
    thedaw::util::setThreadTag("parent");
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(parentPid));
    if (parent == nullptr) {
        thedaw::util::log::writef("parent pid %u is already gone; shutting down", parentPid);
        thedaw::postHostQuit(kExitOk);
        return;
    }
    WaitForSingleObject(parent, INFINITE);
    CloseHandle(parent);
    thedaw::util::log::writef("parent pid %u exited; shutting down", parentPid);
    thedaw::postHostQuit(kExitOk);
}

int runRenderMode(const thedaw::Options& options) {
    thedaw::MessageLoop loop;
    std::string error;
    if (!loop.init(error)) {
        std::fputs((error + "\n").c_str(), stderr);
        return 6;
    }
    const int exitCode = thedaw::runRender(options, loop);
    loop.shutdown();
    return exitCode;
}

int runServe(const thedaw::Options& options) {
    thedaw::MessageLoop loop;
    std::string error;
    if (!loop.init(error)) {
        std::fputs((error + "\n").c_str(), stderr);
        return 6;
    }

    thedaw::Session session;
    int exitCode = kExitOk;
    if (!session.start(options, loop, error, exitCode)) {
        thedaw::json::Writer writer;
        writer.beginObject()
            .strField("ev", "error")
            .strField("text", error)
            .boolField("fatal", true)
            .endObject();
        printLine(writer.text());
        std::fputs((error + "\n").c_str(), stderr);
        std::fflush(stderr);
        thedaw::util::log::writef("startup failed (exit %d): %s", exitCode, error.c_str());
        loop.shutdown();
        return exitCode == 0 ? kExitPluginFailed : exitCode;
    }

    // The backend reads exactly this line to learn the port.
    thedaw::json::Writer listening;
    listening.beginObject()
        .strField("ev", "listening")
        .intField("port", session.port())
        .intField("pid", static_cast<long long>(GetCurrentProcessId()))
        .intField("protocol", 1)
        .endObject();
    printLine(listening.text());
    thedaw::util::log::writef("listening line published for port %d", session.port());

    std::thread(stdinWatcher).detach();
    if (options.parentPid != 0) {
        const unsigned parentPid = options.parentPid;
        std::thread([parentPid] { parentWatcher(parentPid); }).detach();
    }

    const int loopExit = loop.run();
    session.stop();
    loop.shutdown();
    return loopExit;
}

}  // namespace

int main() {
    int argumentCount = 0;
    LPWSTR* wideArgv = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    std::vector<std::wstring> arguments;
    if (wideArgv != nullptr) {
        for (int i = 1; i < argumentCount; ++i) arguments.emplace_back(wideArgv[i]);
        LocalFree(wideArgv);
    }

    thedaw::Options options;
    std::string error;
    if (!thedaw::parseArgs(arguments, options, error)) {
        std::fputs((error + "\n\n").c_str(), stderr);
        std::fputs(thedaw::usageText(), stderr);
        std::fflush(stderr);
        return kExitBadArgs;
    }

    switch (options.mode) {
        case thedaw::RunMode::Help:
            std::fputs(thedaw::usageText(), stdout);
            std::fflush(stdout);
            return kExitOk;
        case thedaw::RunMode::Version:
            printVersion();
            return kExitOk;
        case thedaw::RunMode::SelfTest: {
            // Both suites always run (never short-circuited) so one report is
            // never hidden by the other; either one failing fails the process.
            const int engineFailures = thedaw::runSelfTest();
            const int wsFailures = thedaw::net::runWsHardeningSelfTest();
            return (engineFailures != 0 || wsFailures != 0) ? 1 : 0;
        }
        default:
            break;
    }

    if (!options.logFile.empty()) {
        std::string logError;
        if (!thedaw::util::log::open(options.logFile, logError)) {
            std::fputs((logError + "\n").c_str(), stderr);
            std::fflush(stderr);
            return kExitBadArgs;
        }
        thedaw::util::log::startDrainThread();
        thedaw::util::log::writef("thedaw-vst-host %s starting (pid %lu)", kHostVersion,
                                  GetCurrentProcessId());
    }

    // Host presentation and diagnostics are process-wide and must be in force before any plugin
    // is created, so they are applied here rather than inside a run mode.
    if (!options.hostName.empty()) thedaw::setVst3HostName(options.hostName);
    if (options.iidLog) thedaw::setVst3IidLogging(true);

    int exitCode = kExitOk;
    if (options.mode == thedaw::RunMode::Render) {
        exitCode = runRenderMode(options);
    } else if (options.mode == thedaw::RunMode::List) {
        // Existence is checked here so both the real VST3 layer and the stub
        // report "file not found" the same way.
        if (!thedaw::util::fileExists(options.pluginPath) &&
            GetFileAttributesW(options.pluginPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
            const std::string message =
                "plugin file not found: " + thedaw::util::wideToUtf8(options.pluginPath);
            std::fputs((message + "\n").c_str(), stderr);
            std::fflush(stderr);
            exitCode = kExitPluginMissing;
        } else {
            exitCode = runList(options);
        }
    } else {
        exitCode = runServe(options);
    }

    thedaw::util::log::writef("exiting with code %d", exitCode);
    thedaw::util::log::close();
    return exitCode;
}
