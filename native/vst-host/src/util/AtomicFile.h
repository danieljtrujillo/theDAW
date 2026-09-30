// Crash-safe file replacement: a reader never observes a half-written state file.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace thedaw::util {

bool fileExists(const std::wstring& path);

// readFile is the 64 MB control-plane wrapper for small state/params documents.
// readFileLimited is for bulk media (e.g. WAV audio) that may legitimately be larger.
inline constexpr uint64_t kSmallFileLimitBytes = 64ull * 1024ull * 1024ull;

bool readFile(const std::wstring& path, std::vector<uint8_t>& out, std::string& error);

bool readFileLimited(const std::wstring& path, uint64_t maxBytes, std::vector<uint8_t>& out,
                     std::string& error);

// Writes to "<path>.<pid>.tmp", flushes it to disk, then replaces `path` with a
// single MoveFileExW. The temporary file is removed on any failure.
bool writeFileAtomic(const std::wstring& path, const void* data, size_t size,
                     std::string& error);

}  // namespace thedaw::util
