#include "MessageLoop.h"

#include <objbase.h>
#include <ole2.h>

#include <atomic>

#include "../plugin/IPluginInstance.h"
#include "../util/Log.h"

namespace thedaw {
namespace {

constexpr UINT kMessageRunTask = WM_APP + 1;
constexpr UINT kMessageQuit = WM_APP + 2;
const wchar_t kWindowClass[] = L"theDAWVstHostMessageWindow";

std::atomic<HWND> gMessageWindow{nullptr};
std::atomic<unsigned long> gMessageThreadId{0};

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 without requiring a specific SDK
// baseline at compile time.
void enablePerMonitorV2Dpi() {
    using SetContextFn = BOOL(WINAPI*)(HANDLE);
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (user32 == nullptr) return;
    auto setContext = reinterpret_cast<SetContextFn>(
        reinterpret_cast<void*>(GetProcAddress(user32, "SetProcessDpiAwarenessContext")));
    if (setContext != nullptr) {
        // -4 == DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        if (setContext(reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4)))) return;
    }
    using SetDpiAwareFn = BOOL(WINAPI*)();
    auto setAware = reinterpret_cast<SetDpiAwareFn>(
        reinterpret_cast<void*>(GetProcAddress(user32, "SetProcessDPIAware")));
    if (setAware != nullptr) setAware();
}

}  // namespace

void postToMessageThread(MessageTask task, void* context) {
    if (task == nullptr) return;
    HWND window = gMessageWindow.load(std::memory_order_acquire);
    if (window == nullptr) return;
    PostMessageW(window, kMessageRunTask, reinterpret_cast<WPARAM>(task),
                 reinterpret_cast<LPARAM>(context));
}

bool isMessageThread() {
    return GetCurrentThreadId() == gMessageThreadId.load(std::memory_order_acquire);
}

void postHostQuit(int exitCode) {
    HWND window = gMessageWindow.load(std::memory_order_acquire);
    if (window == nullptr) return;
    PostMessageW(window, kMessageQuit, static_cast<WPARAM>(exitCode), 0);
}

MessageLoop::~MessageLoop() { shutdown(); }

LRESULT CALLBACK MessageLoop::windowProc(HWND hwnd, UINT message, WPARAM wParam,
                                         LPARAM lParam) {
    switch (message) {
        case kMessageRunTask: {
            auto task = reinterpret_cast<MessageTask>(wParam);
            if (task != nullptr) task(reinterpret_cast<void*>(lParam));
            return 0;
        }
        case kMessageQuit:
            PostQuitMessage(static_cast<int>(wParam));
            return 0;
        default:
            return DefWindowProcW(hwnd, message, wParam, lParam);
    }
}

bool MessageLoop::init(std::string& error) {
    enablePerMonitorV2Dpi();

    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (comResult == S_OK || comResult == S_FALSE) comInitialised_ = true;
    if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) {
        error = "CoInitializeEx failed";
        return false;
    }
    // Plugin editors use OLE drag/drop and the clipboard.
    if (SUCCEEDED(OleInitialize(nullptr))) oleInitialised_ = true;

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = &MessageLoop::windowProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.lpszClassName = kWindowClass;
    if (RegisterClassExW(&windowClass) == 0) {
        const DWORD code = GetLastError();
        if (code != ERROR_CLASS_ALREADY_EXISTS) {
            error = "RegisterClassExW failed with " + std::to_string(code);
            return false;
        }
    }
    classRegistered_ = true;

    window_ = CreateWindowExW(0, kWindowClass, L"thedaw-vst-host", 0, 0, 0, 0, 0,
                              HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (window_ == nullptr) {
        error = "CreateWindowExW failed with " + std::to_string(GetLastError());
        return false;
    }

    gMessageWindow.store(window_, std::memory_order_release);
    gMessageThreadId.store(GetCurrentThreadId(), std::memory_order_release);
    util::setThreadTag("message");
    return true;
}

void MessageLoop::shutdown() {
    gMessageWindow.store(nullptr, std::memory_order_release);
    if (window_ != nullptr) {
        DestroyWindow(window_);
        window_ = nullptr;
    }
    if (classRegistered_) {
        UnregisterClassW(kWindowClass, GetModuleHandleW(nullptr));
        classRegistered_ = false;
    }
    if (oleInitialised_) {
        OleUninitialize();
        oleInitialised_ = false;
    }
    if (comInitialised_) {
        CoUninitialize();
        comInitialised_ = false;
    }
}

bool MessageLoop::addEvent(HANDLE handle, Callback callback, void* context) {
    if (handle == nullptr || callback == nullptr) return false;
    if (events_.size() >= MAXIMUM_WAIT_OBJECTS - 1) return false;
    events_.push_back(EventEntry{handle, callback, context});
    return true;
}

void MessageLoop::setTick(Callback callback, void* context, unsigned intervalMs) {
    tick_ = callback;
    tickContext_ = context;
    tickIntervalMs_ = intervalMs == 0 ? 1 : intervalMs;
}

void MessageLoop::postQuit(int exitCode) {
    HWND window = gMessageWindow.load(std::memory_order_acquire);
    if (window != nullptr) PostMessageW(window, kMessageQuit, static_cast<WPARAM>(exitCode), 0);
}

bool MessageLoop::pumpMessages() {
    MSG message;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == WM_QUIT) {
            quit_ = true;
            exitCode_ = static_cast<int>(message.wParam);
            return false;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return true;
}

int MessageLoop::run() {
    std::vector<HANDLE> handles;
    handles.reserve(events_.size());
    for (const EventEntry& entry : events_) handles.push_back(entry.handle);
    const DWORD count = static_cast<DWORD>(handles.size());

    ULONGLONG lastTick = GetTickCount64();

    while (!quit_) {
        const ULONGLONG now = GetTickCount64();
        const ULONGLONG sinceTick = now - lastTick;
        const DWORD waitMs =
            sinceTick >= tickIntervalMs_
                ? 0
                : static_cast<DWORD>(tickIntervalMs_ - sinceTick);

        const DWORD result = MsgWaitForMultipleObjectsEx(
            count, handles.empty() ? nullptr : handles.data(), waitMs, QS_ALLINPUT,
            MWMO_INPUTAVAILABLE);

        if (result == WAIT_FAILED) {
            util::log::writef("MsgWaitForMultipleObjectsEx failed with %lu",
                              GetLastError());
            break;
        }
        if (result >= WAIT_OBJECT_0 && result < WAIT_OBJECT_0 + count) {
            const size_t index = static_cast<size_t>(result - WAIT_OBJECT_0);
            events_[index].callback(events_[index].context);
        }
        if (!quit_ && !pumpMessages()) break;

        // Time-driven so a busy event or message stream cannot starve it.
        if (!quit_ && tick_ != nullptr &&
            GetTickCount64() - lastTick >= tickIntervalMs_) {
            lastTick = GetTickCount64();
            tick_(tickContext_);
        }
    }
    return exitCode_;
}

}  // namespace thedaw
