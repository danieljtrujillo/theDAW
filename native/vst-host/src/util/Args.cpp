#include "Args.h"

#include <cmath>

#include "StringUtil.h"

namespace thedaw {
namespace {

bool isHex32(const std::string& text) {
    if (text.size() != 32) return false;
    for (char c : text) {
        const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                         (c >= 'A' && c <= 'F');
        if (!hex) return false;
    }
    return true;
}

}  // namespace

const char* usageText() {
    return
        "thedaw-vst-host - theDAW live VST host\n"
        "\n"
        "Usage:\n"
        "  thedaw-vst-host --plugin <path.vst3> [--plugin-name <name> | --class-id <32 hex>]\n"
        "                  [--sample-rate 48000] [--block-size 512] [--channels 2]\n"
        "                  [--state-file <path>] [--port 0] [--idle-timeout 0]\n"
        "                  [--parent-pid <pid>] [--log <file>]\n"
        "  thedaw-vst-host --null-plugin [...]      passthrough host, loads no plugin\n"
        "  thedaw-vst-host --render --plugin <path.vst3> --in <in.wav> --out <out.wav>\n"
        "                  [--plugin-name <name> | --class-id <32 hex>] [--state-file <path>]\n"
        "                  [--params-json <json|path>] [--midi-events <path>] [--block-size 1024]\n"
        "                  [--automation-json <path>]\n"
        "                  [--tail-seconds auto|N] [--host-name <name>] [--iid-log]\n"
        "                                           render a file faster than real time\n"
        "  thedaw-vst-host --list --plugin <path>   print the file's plugin classes as JSON\n"
        "  thedaw-vst-host --selftest               run the built-in vectors\n"
        "  thedaw-vst-host --version                print build info as JSON\n"
        "  thedaw-vst-host --help\n"
        "\n"
        "The server listens on 127.0.0.1 only and prints one line to stdout when ready:\n"
        "  {\"ev\":\"listening\",\"port\":N,\"pid\":P,\"protocol\":1}\n"
        "\n"
        "stdin accepts line-delimited JSON; {\"op\":\"shutdown\"} or EOF exits cleanly.\n"
        "\n"
        "--render reads PCM 16/24/32-bit or 32-bit float RIFF/WAVE, processes it in kOffline\n"
        "mode, compensates the plugin's reported latency, renders its tail and writes a\n"
        "32-bit float WAV at the input's rate and channel count. A JSON report goes to stdout.\n"
        "--midi-events plays MIDI into the plugin during the render (an instrument): one message\n"
        "per line, \"<sample frame> <status> <data1> [<data2>]\" in decimal.\n"
        "--automation-json moves parameters during the render: a JSON array of\n"
        "{\"index\":N,\"name\":\"...\",\"points\":[[frame,value],...]}, each a piecewise-linear\n"
        "curve of a normalized value, applied at the start of every block.\n"
        "\n"
        "Exit codes: 0 clean, 1 the render could not be written, 2 bad args,\n"
        "            3 plugin file not found, 4 plugin failed to load/initialize,\n"
        "            5 unsupported bus layout, 6 socket error, 7 unreadable input file.\n";
}

bool parseArgs(const std::vector<std::wstring>& argv, Options& out, std::string& error) {
    Options options;
    bool sawList = false;
    bool sawSelfTest = false;
    bool sawHelp = false;
    bool sawVersion = false;
    bool sawRender = false;

    auto needValue = [&](size_t& i, const std::string& flag, std::wstring& value) {
        if (i + 1 >= argv.size()) {
            error = flag + " needs a value";
            return false;
        }
        value = argv[++i];
        return true;
    };

    for (size_t i = 0; i < argv.size(); ++i) {
        const std::string flag = util::wideToUtf8(argv[i]);
        std::wstring wideValue;

        if (flag == "--help" || flag == "-h" || flag == "/?") {
            sawHelp = true;
        } else if (flag == "--version") {
            sawVersion = true;
        } else if (flag == "--selftest") {
            sawSelfTest = true;
        } else if (flag == "--list") {
            sawList = true;
        } else if (flag == "--render") {
            sawRender = true;
        } else if (flag == "--in") {
            if (!needValue(i, flag, wideValue)) return false;
            options.inputPath = wideValue;
        } else if (flag == "--out") {
            if (!needValue(i, flag, wideValue)) return false;
            options.outputPath = wideValue;
        } else if (flag == "--params-json") {
            if (!needValue(i, flag, wideValue)) return false;
            options.paramsJson = wideValue;
        } else if (flag == "--midi-events") {
            if (!needValue(i, flag, wideValue)) return false;
            options.midiEvents = wideValue;
        } else if (flag == "--automation-json") {
            if (!needValue(i, flag, wideValue)) return false;
            options.automationJson = wideValue;
        } else if (flag == "--host-name") {
            if (!needValue(i, flag, wideValue)) return false;
            options.hostName = util::wideToUtf8(wideValue);
        } else if (flag == "--iid-log") {
            options.iidLog = true;
        } else if (flag == "--tail-seconds") {
            if (!needValue(i, flag, wideValue)) return false;
            const std::string text = util::trim(util::wideToUtf8(wideValue));
            if (util::iequals(text, "auto")) {
                options.tailSeconds = -1.0;
            } else {
                double value = 0;
                if (!util::parseDouble(text, value) || !std::isfinite(value) || value < 0.0 ||
                    value > 600.0) {
                    error = "--tail-seconds must be \"auto\" or a number of seconds from 0 to 600";
                    return false;
                }
                options.tailSeconds = value;
            }
        } else if (flag == "--null-plugin") {
            options.nullPlugin = true;
        } else if (flag == "--plugin") {
            if (!needValue(i, flag, wideValue)) return false;
            options.pluginPath = wideValue;
        } else if (flag == "--plugin-name") {
            if (!needValue(i, flag, wideValue)) return false;
            options.pluginName = util::wideToUtf8(wideValue);
        } else if (flag == "--class-id") {
            if (!needValue(i, flag, wideValue)) return false;
            options.classId = util::wideToUtf8(wideValue);
            if (!isHex32(options.classId)) {
                error = "--class-id must be exactly 32 hex characters";
                return false;
            }
        } else if (flag == "--state-file") {
            if (!needValue(i, flag, wideValue)) return false;
            options.stateFile = wideValue;
        } else if (flag == "--log") {
            if (!needValue(i, flag, wideValue)) return false;
            options.logFile = wideValue;
        } else if (flag == "--sample-rate") {
            if (!needValue(i, flag, wideValue)) return false;
            double value = 0;
            if (!util::parseDouble(util::wideToUtf8(wideValue), value) ||
                !std::isfinite(value) || value < 8000.0 || value > 768000.0) {
                error = "--sample-rate must be a number between 8000 and 768000";
                return false;
            }
            options.sampleRate = value;
        } else if (flag == "--block-size") {
            if (!needValue(i, flag, wideValue)) return false;
            long long value = 0;
            if (!util::parseInt(util::wideToUtf8(wideValue), value) || value < 1 ||
                value > 16384) {
                error = "--block-size must be an integer between 1 and 16384";
                return false;
            }
            options.blockSize = static_cast<int>(value);
        } else if (flag == "--channels") {
            if (!needValue(i, flag, wideValue)) return false;
            long long value = 0;
            if (!util::parseInt(util::wideToUtf8(wideValue), value) || value < 1 ||
                value > 8) {
                error = "--channels must be an integer between 1 and 8";
                return false;
            }
            options.channels = static_cast<int>(value);
        } else if (flag == "--port") {
            if (!needValue(i, flag, wideValue)) return false;
            long long value = 0;
            if (!util::parseInt(util::wideToUtf8(wideValue), value) || value < 0 ||
                value > 65535) {
                error = "--port must be an integer between 0 and 65535";
                return false;
            }
            if (value == 3000) {
                error = "--port 3000 is reserved and must never be used";
                return false;
            }
            options.port = static_cast<int>(value);
        } else if (flag == "--idle-timeout") {
            if (!needValue(i, flag, wideValue)) return false;
            long long value = 0;
            if (!util::parseInt(util::wideToUtf8(wideValue), value) || value < 0 ||
                value > 86400) {
                error = "--idle-timeout must be an integer between 0 and 86400 seconds";
                return false;
            }
            options.idleTimeoutSec = static_cast<int>(value);
        } else if (flag == "--parent-pid") {
            if (!needValue(i, flag, wideValue)) return false;
            long long value = 0;
            if (!util::parseInt(util::wideToUtf8(wideValue), value) || value < 1 ||
                value > 0xFFFFFFFFLL) {
                error = "--parent-pid must be a positive process id";
                return false;
            }
            options.parentPid = static_cast<unsigned>(value);
        } else {
            error = "unknown argument: " + flag;
            return false;
        }
    }

    if (sawHelp) {
        options.mode = RunMode::Help;
        out = options;
        return true;
    }
    if (sawVersion) {
        options.mode = RunMode::Version;
        out = options;
        return true;
    }
    if (sawSelfTest) {
        if (sawList) {
            error = "--selftest and --list are mutually exclusive";
            return false;
        }
        options.mode = RunMode::SelfTest;
        out = options;
        return true;
    }
    if (sawList) {
        if (sawRender) {
            error = "--list and --render are mutually exclusive";
            return false;
        }
        if (options.pluginPath.empty()) {
            error = "--list needs --plugin <path.vst3>";
            return false;
        }
        options.mode = RunMode::List;
        out = options;
        return true;
    }
    if (sawRender) {
        if (options.inputPath.empty()) {
            error = "--render needs --in <input.wav>";
            return false;
        }
        if (options.outputPath.empty()) {
            error = "--render needs --out <output.wav>";
            return false;
        }
        if (options.nullPlugin && !options.pluginPath.empty()) {
            error = "--null-plugin and --plugin are mutually exclusive";
            return false;
        }
        if (!options.nullPlugin && options.pluginPath.empty()) {
            error = "--render needs one of --plugin <path.vst3> or --null-plugin";
            return false;
        }
        if (!options.pluginName.empty() && !options.classId.empty()) {
            error = "--plugin-name and --class-id are mutually exclusive";
            return false;
        }
        options.mode = RunMode::Render;
        out = options;
        return true;
    }

    options.mode = RunMode::Serve;
    if (options.nullPlugin && !options.pluginPath.empty()) {
        error = "--null-plugin and --plugin are mutually exclusive";
        return false;
    }
    if (!options.nullPlugin && options.pluginPath.empty()) {
        error = "one of --plugin <path.vst3> or --null-plugin is required";
        return false;
    }
    if (!options.pluginName.empty() && !options.classId.empty()) {
        error = "--plugin-name and --class-id are mutually exclusive";
        return false;
    }
    out = options;
    return true;
}

}  // namespace thedaw
