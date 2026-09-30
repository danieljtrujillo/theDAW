// A JSON reader/writer sized for the live-VST control protocol: flat messages
// plus the `params` list. Everything arriving here came off a socket, so the
// parser is bounded in size, depth and element count and reports the first
// malformed byte rather than guessing.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace thedaw::json {

inline constexpr size_t kMaxDocumentBytes = 8u * 1024u * 1024u;
inline constexpr int kMaxDepth = 32;
inline constexpr size_t kMaxElements = 100000;

enum class Type { Null, Bool, Number, String, Array, Object };

class Value {
public:
    Type type = Type::Null;
    bool boolean = false;
    double number = 0.0;
    std::string str;
    std::vector<Value> array;
    std::vector<std::pair<std::string, Value>> object;

    bool isNull() const { return type == Type::Null; }
    bool isBool() const { return type == Type::Bool; }
    bool isNumber() const { return type == Type::Number; }
    bool isString() const { return type == Type::String; }
    bool isArray() const { return type == Type::Array; }
    bool isObject() const { return type == Type::Object; }

    // Object lookup; returns nullptr when absent or when this is not an object.
    const Value* find(const std::string& key) const;

    std::string stringOr(const std::string& key, const std::string& fallback) const;
    double numberOr(const std::string& key, double fallback) const;
    bool boolOr(const std::string& key, bool fallback) const;
};

// Returns false and fills `error` for malformed, oversized or too-deeply nested
// input. Trailing non-whitespace bytes are an error.
bool parse(const std::string& text, Value& out, std::string& error);

// Shortest representation that round-trips; integral values print without a
// fractional part, and non-finite values become null (JSON has no NaN/Inf).
std::string formatNumber(double value);

// Escapes per RFC 8259 and replaces invalid UTF-8 with U+FFFD, because plugin
// vendors put arbitrary bytes in their name strings.
std::string escapeString(const std::string& text);

// Incremental writer for the messages the host sends.
class Writer {
public:
    Writer& beginObject();
    Writer& endObject();
    Writer& beginArray();
    Writer& endArray();

    Writer& key(const char* name);
    Writer& valueString(const std::string& text);
    Writer& valueNumber(double value);
    Writer& valueInt(long long value);
    Writer& valueBool(bool value);
    Writer& valueNull();

    Writer& strField(const char* name, const std::string& text);
    Writer& numField(const char* name, double value);
    Writer& intField(const char* name, long long value);
    Writer& boolField(const char* name, bool value);

    const std::string& text() const { return out_; }
    std::string take() { return std::move(out_); }

private:
    void separate();

    std::string out_;
    std::vector<bool> needComma_;
};

}  // namespace thedaw::json
