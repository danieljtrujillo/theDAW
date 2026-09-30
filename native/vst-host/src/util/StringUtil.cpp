#include "StringUtil.h"

#include <windows.h>

#include <cerrno>
#include <cstdlib>

namespace thedaw::util {

char asciiLower(char c) {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

std::string toLowerAscii(std::string s) {
    for (char& c : s) c = asciiLower(c);
    return s;
}

bool iequals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (asciiLower(a[i]) != asciiLower(b[i])) return false;
    }
    return true;
}

bool startsWithIgnoreCase(const std::string& text, const std::string& prefix) {
    if (text.size() < prefix.size()) return false;
    for (size_t i = 0; i < prefix.size(); ++i) {
        if (asciiLower(text[i]) != asciiLower(prefix[i])) return false;
    }
    return true;
}

std::string trim(const std::string& s) {
    size_t begin = 0;
    size_t end = s.size();
    auto isSpace = [](char c) {
        return c == ' ' || c == '\t' || c == '\r' || c == '\n';
    };
    while (begin < end && isSpace(s[begin])) ++begin;
    while (end > begin && isSpace(s[end - 1])) --end;
    return s.substr(begin, end - begin);
}

std::wstring utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    const int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(),
                                           static_cast<int>(s.size()), nullptr, 0);
    if (needed <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(needed), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(),
                                            static_cast<int>(s.size()), out.data(), needed);
    if (written != needed) return std::wstring();
    return out;
}

std::string wideToUtf8(const std::wstring& s) {
    if (s.empty()) return std::string();
    const int needed = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                                           nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return std::string();
    std::string out(static_cast<size_t>(needed), '\0');
    const int written = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                                            out.data(), needed, nullptr, nullptr);
    if (written != needed) return std::string();
    return out;
}

bool parseInt(const std::string& text, long long& out) {
    if (text.empty()) return false;
    errno = 0;
    char* end = nullptr;
    const long long value = _strtoi64(text.c_str(), &end, 10);
    if (errno != 0 || end == text.c_str() || *end != '\0') return false;
    out = value;
    return true;
}

bool parseDouble(const std::string& text, double& out) {
    if (text.empty()) return false;
    errno = 0;
    char* end = nullptr;
    const double value = strtod(text.c_str(), &end);
    if (errno != 0 || end == text.c_str() || *end != '\0') return false;
    out = value;
    return true;
}

std::string toString(long long value) {
    char buffer[32];
    _i64toa_s(value, buffer, sizeof(buffer), 10);
    return std::string(buffer);
}

}  // namespace thedaw::util
