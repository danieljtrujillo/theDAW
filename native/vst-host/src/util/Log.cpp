#include "Log.h"

#include <windows.h>

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <thread>

#include "SpscQueue.h"

namespace thedaw::util {
namespace {

thread_local const char* tThreadTag = "main";

struct AudioNote {
    const char* message = nullptr;
    long long a = 0;
    long long b = 0;
};

struct LogState {
    std::mutex mutex;
    HANDLE file = INVALID_HANDLE_VALUE;
    std::atomic<bool> open{false};
    SpscQueue<AudioNote, 256> audioNotes;
    std::thread drainThread;
    std::atomic<bool> draining{false};
};

LogState& state() {
    static LogState instance;
    return instance;
}

std::string timestamp() {
    SYSTEMTIME now{};
    GetLocalTime(&now);
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02u %02u:%02u:%02u.%03u", now.wYear,
                  now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond,
                  now.wMilliseconds);
    return std::string(buffer);
}

// Caller holds the mutex.
void writeLocked(const char* tag, const std::string& line) {
    LogState& s = state();
    if (s.file == INVALID_HANDLE_VALUE) return;
    std::string full = timestamp();
    full += " [";
    full += tag;
    full += "] ";
    full += line;
    full += "\r\n";
    DWORD written = 0;
    WriteFile(s.file, full.data(), static_cast<DWORD>(full.size()), &written, nullptr);
}

}  // namespace

void setThreadTag(const char* tag) { tThreadTag = tag; }

namespace log {

bool open(const std::wstring& path, std::string& error) {
    LogState& s = state();
    std::lock_guard<std::mutex> guard(s.mutex);
    if (s.file != INVALID_HANDLE_VALUE) return true;
    // Shared read so the backend can tail the log while the host runs.
    HANDLE handle = CreateFileW(path.c_str(), FILE_APPEND_DATA,
                                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        error = "cannot open log file (error " + std::to_string(GetLastError()) + ")";
        return false;
    }
    s.file = handle;
    s.open.store(true, std::memory_order_release);
    return true;
}

void close() {
    stopDrainThread();
    LogState& s = state();
    std::lock_guard<std::mutex> guard(s.mutex);
    if (s.file == INVALID_HANDLE_VALUE) return;
    FlushFileBuffers(s.file);
    CloseHandle(s.file);
    s.file = INVALID_HANDLE_VALUE;
    s.open.store(false, std::memory_order_release);
}

void startDrainThread() {
    LogState& s = state();
    if (!s.open.load(std::memory_order_acquire)) return;
    if (s.draining.exchange(true)) return;
    s.drainThread = std::thread([] {
        LogState& inner = state();
        setThreadTag("logger");
        while (inner.draining.load(std::memory_order_acquire)) {
            drainAudioNotes();
            Sleep(25);
        }
        drainAudioNotes();
    });
}

void stopDrainThread() {
    LogState& s = state();
    if (!s.draining.exchange(false)) return;
    if (s.drainThread.joinable()) s.drainThread.join();
}

bool enabled() { return state().open.load(std::memory_order_acquire); }

void write(const std::string& line) {
    LogState& s = state();
    if (!s.open.load(std::memory_order_acquire)) return;
    std::lock_guard<std::mutex> guard(s.mutex);
    writeLocked(tThreadTag, line);
}

void writef(const char* format, ...) {
    if (!enabled()) return;
    char buffer[1024];
    va_list args;
    va_start(args, format);
    const int written = std::vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    if (written < 0) return;
    write(std::string(buffer));
}

void audioNote(const char* message, long long a, long long b) {
    LogState& s = state();
    if (!s.open.load(std::memory_order_acquire)) return;
    AudioNote* slot = s.audioNotes.writeSlot();
    if (slot == nullptr) return;  // ring full: dropping is better than blocking
    slot->message = message;
    slot->a = a;
    slot->b = b;
    s.audioNotes.commitWrite();
}

void drainAudioNotes() {
    LogState& s = state();
    if (!s.open.load(std::memory_order_acquire)) return;
    AudioNote note;
    while (s.audioNotes.pop(note)) {
        if (note.message == nullptr) continue;
        char buffer[512];
        std::snprintf(buffer, sizeof(buffer), "%s %lld %lld", note.message, note.a, note.b);
        std::lock_guard<std::mutex> guard(s.mutex);
        writeLocked("audio", buffer);
    }
    std::lock_guard<std::mutex> guard(s.mutex);
    if (s.file != INVALID_HANDLE_VALUE) FlushFileBuffers(s.file);
}

}  // namespace log
}  // namespace thedaw::util
