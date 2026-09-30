#include "message_loop.h"

#include <windows.h>

#include <chrono>
#include <thread>

#include "plugin/IPluginInstance.h"

namespace thedaw {
namespace probe {
namespace {

constexpr const wchar_t* kClassName = L"theDAW_VST3_Probe_Dispatch";
constexpr UINT kRunTask = WM_APP + 1;

HWND g_dispatchWindow = nullptr;
DWORD g_messageThreadId = 0;

LRESULT CALLBACK dispatchProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == kRunTask) {
        auto task = reinterpret_cast<MessageTask>(wParam);
        if (task != nullptr) task(reinterpret_cast<void*>(lParam));
        return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

}  // namespace

bool startMessageThread() {
    if (g_dispatchWindow != nullptr) return true;

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &dispatchProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = kClassName;
    if (RegisterClassExW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;

    g_dispatchWindow = CreateWindowExW(0, kClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr,
                                       GetModuleHandleW(nullptr), nullptr);
    if (g_dispatchWindow == nullptr) return false;
    g_messageThreadId = GetCurrentThreadId();
    return true;
}

void stopMessageThread() {
    if (g_dispatchWindow != nullptr) {
        DestroyWindow(g_dispatchWindow);
        g_dispatchWindow = nullptr;
    }
    g_messageThreadId = 0;
}

bool pumpMessages() {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == WM_QUIT) return false;
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return true;
}

void pumpFor(double seconds) {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::duration<double>(seconds);
    while (std::chrono::steady_clock::now() < deadline) {
        if (!pumpMessages()) return;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    pumpMessages();
}

}  // namespace probe

// ---- the two hooks IPluginInstance.h leaves to the host ----

void postToMessageThread(MessageTask task, void* context) {
    if (probe::g_dispatchWindow == nullptr || task == nullptr) return;
    PostMessageW(probe::g_dispatchWindow, probe::kRunTask, reinterpret_cast<WPARAM>(task),
                 reinterpret_cast<LPARAM>(context));
}

bool isMessageThread() {
    return probe::g_messageThreadId != 0 && GetCurrentThreadId() == probe::g_messageThreadId;
}

}  // namespace thedaw
