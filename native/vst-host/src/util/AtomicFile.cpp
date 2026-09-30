#include "AtomicFile.h"

#include <windows.h>

namespace thedaw::util {
namespace {

class FileHandle {
public:
    explicit FileHandle(HANDLE handle) : handle_(handle) {}
    ~FileHandle() { reset(); }
    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;

    HANDLE get() const { return handle_; }
    bool valid() const { return handle_ != INVALID_HANDLE_VALUE; }
    void reset() {
        if (handle_ != INVALID_HANDLE_VALUE) {
            CloseHandle(handle_);
            handle_ = INVALID_HANDLE_VALUE;
        }
    }

private:
    HANDLE handle_;
};

std::string lastErrorText(const char* what) {
    return std::string(what) + " (error " + std::to_string(GetLastError()) + ")";
}

}  // namespace

bool fileExists(const std::wstring& path) {
    if (path.empty()) return false;
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
           (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool readFileLimited(const std::wstring& path, uint64_t maxBytes, std::vector<uint8_t>& out,
                     std::string& error) {
    out.clear();
    FileHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file.valid()) {
        error = lastErrorText("cannot open file");
        return false;
    }
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.get(), &size)) {
        error = lastErrorText("cannot size file");
        return false;
    }
    if (size.QuadPart < 0) {
        error = "file has a negative size";
        return false;
    }
    const uint64_t sizeBytes = static_cast<uint64_t>(size.QuadPart);
    if (sizeBytes > maxBytes) {
        error = "file is " + std::to_string(sizeBytes) + " bytes; the limit here is " +
                std::to_string(maxBytes) + " bytes";
        return false;
    }
    out.resize(static_cast<size_t>(sizeBytes));
    size_t offset = 0;
    while (offset < out.size()) {
        const DWORD chunk =
            static_cast<DWORD>((out.size() - offset) > 0x10000000u ? 0x10000000u
                                                                   : (out.size() - offset));
        DWORD read = 0;
        if (!ReadFile(file.get(), out.data() + offset, chunk, &read, nullptr)) {
            error = lastErrorText("cannot read file");
            out.clear();
            return false;
        }
        if (read == 0) break;
        offset += read;
    }
    if (offset != static_cast<size_t>(sizeBytes)) {
        error = "file ended after " + std::to_string(offset) + " of " + std::to_string(sizeBytes) +
                " bytes";
        out.clear();
        return false;
    }
    return true;
}

bool readFile(const std::wstring& path, std::vector<uint8_t>& out, std::string& error) {
    return readFileLimited(path, kSmallFileLimitBytes, out, error);
}

bool writeFileAtomic(const std::wstring& path, const void* data, size_t size,
                     std::string& error) {
    if (path.empty()) {
        error = "empty path";
        return false;
    }
    const std::wstring temp =
        path + L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp";

    {
        FileHandle file(CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                    FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!file.valid()) {
            error = lastErrorText("cannot create temporary state file");
            return false;
        }
        const uint8_t* bytes = static_cast<const uint8_t*>(data);
        size_t offset = 0;
        while (offset < size) {
            const DWORD chunk =
                static_cast<DWORD>((size - offset) > 0x10000000u ? 0x10000000u
                                                                 : (size - offset));
            DWORD written = 0;
            if (!WriteFile(file.get(), bytes + offset, chunk, &written, nullptr) ||
                written == 0) {
                error = lastErrorText("cannot write temporary state file");
                file.reset();
                DeleteFileW(temp.c_str());
                return false;
            }
            offset += written;
        }
        if (!FlushFileBuffers(file.get())) {
            error = lastErrorText("cannot flush temporary state file");
            file.reset();
            DeleteFileW(temp.c_str());
            return false;
        }
    }

    if (!MoveFileExW(temp.c_str(), path.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        error = lastErrorText("cannot replace state file");
        DeleteFileW(temp.c_str());
        return false;
    }
    return true;
}

}  // namespace thedaw::util
