#include "Json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace thedaw::json {
namespace {

class Parser {
public:
    Parser(const std::string& text, std::string& error) : text_(text), error_(error) {}

    bool run(Value& out) {
        if (text_.size() > kMaxDocumentBytes) return fail("document too large");
        skipWhitespace();
        if (!parseValue(out, 0)) return false;
        skipWhitespace();
        if (pos_ != text_.size()) return fail("trailing data after value");
        return true;
    }

private:
    bool fail(const char* what) {
        error_ = std::string(what) + " at offset " + std::to_string(pos_);
        return false;
    }

    bool atEnd() const { return pos_ >= text_.size(); }
    char peek() const { return text_[pos_]; }

    void skipWhitespace() {
        while (pos_ < text_.size()) {
            const char c = text_[pos_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++pos_;
            } else {
                break;
            }
        }
    }

    bool literal(const char* word, size_t length) {
        if (text_.compare(pos_, length, word) != 0) return fail("unknown literal");
        pos_ += length;
        return true;
    }

    bool parseValue(Value& out, int depth) {
        if (depth > kMaxDepth) return fail("nesting too deep");
        if (atEnd()) return fail("unexpected end of input");
        switch (peek()) {
            case '{':
                return parseObject(out, depth);
            case '[':
                return parseArray(out, depth);
            case '"':
                out.type = Type::String;
                return parseString(out.str);
            case 't':
                if (!literal("true", 4)) return false;
                out.type = Type::Bool;
                out.boolean = true;
                return true;
            case 'f':
                if (!literal("false", 5)) return false;
                out.type = Type::Bool;
                out.boolean = false;
                return true;
            case 'n':
                if (!literal("null", 4)) return false;
                out.type = Type::Null;
                return true;
            default:
                return parseNumber(out);
        }
    }

    bool parseObject(Value& out, int depth) {
        out.type = Type::Object;
        ++pos_;  // '{'
        skipWhitespace();
        if (!atEnd() && peek() == '}') {
            ++pos_;
            return true;
        }
        for (;;) {
            skipWhitespace();
            if (atEnd() || peek() != '"') return fail("expected object key");
            std::string name;
            if (!parseString(name)) return false;
            skipWhitespace();
            if (atEnd() || peek() != ':') return fail("expected ':'");
            ++pos_;
            skipWhitespace();
            Value child;
            if (!parseValue(child, depth + 1)) return false;
            if (++elements_ > kMaxElements) return fail("too many elements");
            out.object.emplace_back(std::move(name), std::move(child));
            skipWhitespace();
            if (atEnd()) return fail("unterminated object");
            if (peek() == ',') {
                ++pos_;
                continue;
            }
            if (peek() == '}') {
                ++pos_;
                return true;
            }
            return fail("expected ',' or '}'");
        }
    }

    bool parseArray(Value& out, int depth) {
        out.type = Type::Array;
        ++pos_;  // '['
        skipWhitespace();
        if (!atEnd() && peek() == ']') {
            ++pos_;
            return true;
        }
        for (;;) {
            skipWhitespace();
            Value child;
            if (!parseValue(child, depth + 1)) return false;
            if (++elements_ > kMaxElements) return fail("too many elements");
            out.array.push_back(std::move(child));
            skipWhitespace();
            if (atEnd()) return fail("unterminated array");
            if (peek() == ',') {
                ++pos_;
                continue;
            }
            if (peek() == ']') {
                ++pos_;
                return true;
            }
            return fail("expected ',' or ']'");
        }
    }

    bool parseHex4(uint32_t& out) {
        if (pos_ + 4 > text_.size()) return fail("truncated \\u escape");
        out = 0;
        for (int i = 0; i < 4; ++i) {
            const char c = text_[pos_++];
            uint32_t digit = 0;
            if (c >= '0' && c <= '9') {
                digit = static_cast<uint32_t>(c - '0');
            } else if (c >= 'a' && c <= 'f') {
                digit = static_cast<uint32_t>(c - 'a' + 10);
            } else if (c >= 'A' && c <= 'F') {
                digit = static_cast<uint32_t>(c - 'A' + 10);
            } else {
                return fail("bad hex digit in \\u escape");
            }
            out = (out << 4) | digit;
        }
        return true;
    }

    static void appendUtf8(std::string& out, uint32_t cp) {
        if (cp < 0x80u) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800u) {
            out.push_back(static_cast<char>(0xC0u | (cp >> 6)));
            out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
        } else if (cp < 0x10000u) {
            out.push_back(static_cast<char>(0xE0u | (cp >> 12)));
            out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
            out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
        } else {
            out.push_back(static_cast<char>(0xF0u | (cp >> 18)));
            out.push_back(static_cast<char>(0x80u | ((cp >> 12) & 0x3Fu)));
            out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
            out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
        }
    }

    bool parseString(std::string& out) {
        out.clear();
        ++pos_;  // opening quote
        for (;;) {
            if (atEnd()) return fail("unterminated string");
            const unsigned char c = static_cast<unsigned char>(text_[pos_]);
            if (c == '"') {
                ++pos_;
                return true;
            }
            if (c < 0x20u) return fail("unescaped control character in string");
            if (c != '\\') {
                out.push_back(static_cast<char>(c));
                ++pos_;
                continue;
            }
            ++pos_;  // backslash
            if (atEnd()) return fail("unterminated escape");
            const char esc = text_[pos_++];
            switch (esc) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    uint32_t unit = 0;
                    if (!parseHex4(unit)) return false;
                    if (unit >= 0xD800u && unit <= 0xDBFFu) {
                        if (pos_ + 1 >= text_.size() || text_[pos_] != '\\' ||
                            text_[pos_ + 1] != 'u') {
                            return fail("lone high surrogate");
                        }
                        pos_ += 2;
                        uint32_t low = 0;
                        if (!parseHex4(low)) return false;
                        if (low < 0xDC00u || low > 0xDFFFu) return fail("bad low surrogate");
                        unit = 0x10000u + ((unit - 0xD800u) << 10) + (low - 0xDC00u);
                    } else if (unit >= 0xDC00u && unit <= 0xDFFFu) {
                        return fail("lone low surrogate");
                    }
                    appendUtf8(out, unit);
                    break;
                }
                default:
                    return fail("unknown escape");
            }
        }
    }

    bool parseNumber(Value& out) {
        const size_t start = pos_;
        if (!atEnd() && peek() == '-') ++pos_;
        if (atEnd() || peek() < '0' || peek() > '9') return fail("expected number");
        if (peek() == '0') {
            ++pos_;
        } else {
            while (!atEnd() && peek() >= '0' && peek() <= '9') ++pos_;
        }
        if (!atEnd() && peek() == '.') {
            ++pos_;
            if (atEnd() || peek() < '0' || peek() > '9') return fail("expected fraction");
            while (!atEnd() && peek() >= '0' && peek() <= '9') ++pos_;
        }
        if (!atEnd() && (peek() == 'e' || peek() == 'E')) {
            ++pos_;
            if (!atEnd() && (peek() == '+' || peek() == '-')) ++pos_;
            if (atEnd() || peek() < '0' || peek() > '9') return fail("expected exponent");
            while (!atEnd() && peek() >= '0' && peek() <= '9') ++pos_;
        }
        const std::string slice = text_.substr(start, pos_ - start);
        char* end = nullptr;
        const double value = std::strtod(slice.c_str(), &end);
        if (end != slice.c_str() + slice.size()) return fail("malformed number");
        if (!std::isfinite(value)) return fail("number out of range");
        out.type = Type::Number;
        out.number = value;
        return true;
    }

    const std::string& text_;
    std::string& error_;
    size_t pos_ = 0;
    size_t elements_ = 0;
};

}  // namespace

const Value* Value::find(const std::string& key) const {
    if (type != Type::Object) return nullptr;
    for (const auto& entry : object) {
        if (entry.first == key) return &entry.second;
    }
    return nullptr;
}

std::string Value::stringOr(const std::string& key, const std::string& fallback) const {
    const Value* found = find(key);
    return (found != nullptr && found->isString()) ? found->str : fallback;
}

double Value::numberOr(const std::string& key, double fallback) const {
    const Value* found = find(key);
    return (found != nullptr && found->isNumber()) ? found->number : fallback;
}

bool Value::boolOr(const std::string& key, bool fallback) const {
    const Value* found = find(key);
    return (found != nullptr && found->isBool()) ? found->boolean : fallback;
}

bool parse(const std::string& text, Value& out, std::string& error) {
    out = Value();
    error.clear();
    Parser parser(text, error);
    if (parser.run(out)) return true;
    if (error.empty()) error = "malformed JSON";
    return false;
}

std::string formatNumber(double value) {
    if (!std::isfinite(value)) return "null";
    if (value == std::floor(value) && std::fabs(value) < 9007199254740992.0) {
        char buffer[32];
        std::snprintf(buffer, sizeof(buffer), "%lld", static_cast<long long>(value));
        return std::string(buffer);
    }
    char buffer[40];
    std::snprintf(buffer, sizeof(buffer), "%.15g", value);
    if (std::strtod(buffer, nullptr) != value) {
        std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    }
    return std::string(buffer);
}

std::string escapeString(const std::string& text) {
    static const char* kHex = "0123456789abcdef";
    std::string out;
    out.reserve(text.size() + 8);
    size_t i = 0;
    while (i < text.size()) {
        const unsigned char c = static_cast<unsigned char>(text[i]);
        if (c < 0x80u) {
            switch (c) {
                case '"': out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\b': out += "\\b"; break;
                case '\f': out += "\\f"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (c < 0x20u) {
                        out += "\\u00";
                        out.push_back(kHex[c >> 4]);
                        out.push_back(kHex[c & 0x0Fu]);
                    } else {
                        out.push_back(static_cast<char>(c));
                    }
            }
            ++i;
            continue;
        }
        // Validate the multi-byte sequence before copying it through.
        size_t length = 0;
        uint32_t cp = 0;
        if ((c & 0xE0u) == 0xC0u) {
            length = 2;
            cp = c & 0x1Fu;
        } else if ((c & 0xF0u) == 0xE0u) {
            length = 3;
            cp = c & 0x0Fu;
        } else if ((c & 0xF8u) == 0xF0u) {
            length = 4;
            cp = c & 0x07u;
        }
        bool valid = length != 0 && i + length <= text.size();
        if (valid) {
            for (size_t k = 1; k < length; ++k) {
                const unsigned char cont = static_cast<unsigned char>(text[i + k]);
                if ((cont & 0xC0u) != 0x80u) {
                    valid = false;
                    break;
                }
                cp = (cp << 6) | (cont & 0x3Fu);
            }
        }
        if (valid) {
            const bool overlong = (length == 2 && cp < 0x80u) ||
                                  (length == 3 && cp < 0x800u) ||
                                  (length == 4 && cp < 0x10000u);
            if (overlong || cp > 0x10FFFFu || (cp >= 0xD800u && cp <= 0xDFFFu)) valid = false;
        }
        if (!valid) {
            out += "\xEF\xBF\xBD";  // U+FFFD
            ++i;
            continue;
        }
        out.append(text, i, length);
        i += length;
    }
    return out;
}

void Writer::separate() {
    if (!needComma_.empty()) {
        if (needComma_.back()) out_.push_back(',');
        needComma_.back() = true;
    }
}

Writer& Writer::beginObject() {
    separate();
    out_.push_back('{');
    needComma_.push_back(false);
    return *this;
}

Writer& Writer::endObject() {
    out_.push_back('}');
    if (!needComma_.empty()) needComma_.pop_back();
    return *this;
}

Writer& Writer::beginArray() {
    separate();
    out_.push_back('[');
    needComma_.push_back(false);
    return *this;
}

Writer& Writer::endArray() {
    out_.push_back(']');
    if (!needComma_.empty()) needComma_.pop_back();
    return *this;
}

Writer& Writer::key(const char* name) {
    separate();
    out_.push_back('"');
    out_ += escapeString(name);
    out_ += "\":";
    // The value that follows belongs to this key, not to a new list entry.
    if (!needComma_.empty()) needComma_.back() = false;
    return *this;
}

Writer& Writer::valueString(const std::string& text) {
    separate();
    out_.push_back('"');
    out_ += escapeString(text);
    out_.push_back('"');
    return *this;
}

Writer& Writer::valueNumber(double value) {
    separate();
    out_ += formatNumber(value);
    return *this;
}

Writer& Writer::valueInt(long long value) {
    separate();
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%lld", value);
    out_ += buffer;
    return *this;
}

Writer& Writer::valueBool(bool value) {
    separate();
    out_ += value ? "true" : "false";
    return *this;
}

Writer& Writer::valueNull() {
    separate();
    out_ += "null";
    return *this;
}

Writer& Writer::strField(const char* name, const std::string& text) {
    key(name);
    return valueString(text);
}

Writer& Writer::numField(const char* name, double value) {
    key(name);
    return valueNumber(value);
}

Writer& Writer::intField(const char* name, long long value) {
    key(name);
    return valueInt(value);
}

Writer& Writer::boolField(const char* name, bool value) {
    key(name);
    return valueBool(value);
}

}  // namespace thedaw::json
