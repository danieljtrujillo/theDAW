// Standard base64 (RFC 4648 section 4) with padding.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace thedaw::util {

std::string base64Encode(const void* data, size_t size);

// Strict: rejects any character outside the standard alphabet (ASCII whitespace
// is skipped so JSON-wrapped blobs with line breaks still decode), rejects a
// length that is not a multiple of four and rejects misplaced padding.
bool base64Decode(const std::string& text, std::vector<uint8_t>& out);

}  // namespace thedaw::util
