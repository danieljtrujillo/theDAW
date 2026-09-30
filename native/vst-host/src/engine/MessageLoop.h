// The process main thread: per-monitor-v2 DPI, COM/OLE, a message-only window
// and the Win32 message loop that plugin editors need.
//
// It waits on the message queue AND on a small set of Win32 events, so the audio
// thread can wake it with SetEvent (realtime safe) instead of PostMessage.
#pragma once

#include <windows.h>

#include <string>
#include <vector>

namespace thedaw {

// Asks the message loop to exit with `exitCode`. Safe from any thread, including
// the detached stdin and parent-watchdog threads, because it only touches
// process-lifetime globals.
void postHostQuit(int exitCode);

class MessageLoop {
public:
    using Callback = void (*)(void* context);

    MessageLoop() = default;
    ~MessageLoop();
    MessageLoop(const MessageLoop&) = delete;
    MessageLoop& operator=(const MessageLoop&) = delete;

    // Sets DPI awareness, initialises COM/OLE and creates the message window.
    bool init(std::string& error);
    void shutdown();

    // Callback runs on the message thread whenever `handle` is signalled.
    bool addEvent(HANDLE handle, Callback callback, void* context);
    void setTick(Callback callback, void* context, unsigned intervalMs);

    int run();
    void postQuit(int exitCode);

    HWND window() const { return window_; }

private:
    static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wParam,
                                       LPARAM lParam);
    bool pumpMessages();

    struct EventEntry {
        HANDLE handle = nullptr;
        Callback callback = nullptr;
        void* context = nullptr;
    };

    HWND window_ = nullptr;
    bool classRegistered_ = false;
    bool comInitialised_ = false;
    bool oleInitialised_ = false;
    std::vector<EventEntry> events_;
    Callback tick_ = nullptr;
    void* tickContext_ = nullptr;
    unsigned tickIntervalMs_ = 10;
    bool quit_ = false;
    int exitCode_ = 0;
};

}  // namespace thedaw
