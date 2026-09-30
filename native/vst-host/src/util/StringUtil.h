// Small string helpers shared by the argument parser, the HTTP handshake and logging.
#pragma once

#include <string>
#include <vector>

namespace thedaw::util {

// ASCII-only case folding: HTTP header names/values and CLI flags are ASCII by
// definition, and locale-aware folding would be both slower and wrong here.
char asciiLower(char c);
std::string toLowerAscii(std::string s);
bool iequals(const std::string& a, const std::string& b);
bool startsWithIgnoreCase(const std::string& text, const std::string& prefix);

std::string trim(const std::string& s);

// UTF-8 <-> UTF-16 for Win32 paths. Both return an empty string on failure,
// which callers treat as "unusable path".
std::wstring utf8ToWide(const std::string& s);
std::string wideToUtf8(const std::wstring& s);

// Parsers that reject trailing garbage ("512x" is not 512).
bool parseInt(const std::string& text, long long& out);
bool parseDouble(const std::string& text, double& out);

// Decimal formatting without the locale machinery in <sstream>.
std::string toString(long long value);

}  // namespace thedaw::util
