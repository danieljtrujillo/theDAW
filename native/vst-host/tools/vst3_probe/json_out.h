// The smallest JSON writer that can produce the probe's report: enough to emit objects, arrays,
// strings, numbers and booleans correctly escaped, and nothing else.
#pragma once

#include <cmath>
#include <string>
#include <vector>

namespace thedaw::probe {

inline std::string jsonString(const std::string& text) {
    std::string out;
    out.reserve(text.size() + 2);
    out.push_back('"');
    for (unsigned char c : text) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    static const char* hex = "0123456789abcdef";
                    out += "\\u00";
                    out.push_back(hex[c >> 4]);
                    out.push_back(hex[c & 0x0F]);
                } else {
                    out.push_back(static_cast<char>(c));  // UTF-8 passes through
                }
                break;
        }
    }
    out.push_back('"');
    return out;
}

inline std::string jsonNumber(double value, int decimals = 6) {
    if (!std::isfinite(value)) return "null";  // JSON has no NaN/Infinity
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.*f", decimals, value);
    std::string out(buffer);
    // Trim the trailing zeros a fixed-point format leaves behind.
    if (out.find('.') != std::string::npos) {
        while (out.size() > 1 && out.back() == '0') out.pop_back();
        if (!out.empty() && out.back() == '.') out.pop_back();
    }
    return out;
}

inline std::string jsonInt(long long value) { return std::to_string(value); }

inline std::string jsonBool(bool value) { return value ? "true" : "false"; }

inline std::string jsonArray(const std::vector<std::string>& items) {
    std::string out = "[";
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i > 0) out += ",";
        out += items[i];
    }
    out += "]";
    return out;
}

// Members are pre-rendered "\"key\":value" strings.
inline std::string jsonObject(const std::vector<std::string>& members) {
    std::string out = "{";
    for (std::size_t i = 0; i < members.size(); ++i) {
        if (i > 0) out += ",";
        out += members[i];
    }
    out += "}";
    return out;
}

inline std::string jsonMember(const std::string& key, const std::string& renderedValue) {
    return jsonString(key) + ":" + renderedValue;
}

}  // namespace thedaw::probe
