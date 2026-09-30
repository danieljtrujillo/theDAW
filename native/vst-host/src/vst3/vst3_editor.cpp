#include "vst3_editor.h"

#include <windows.h>

#include <algorithm>

#include "vst3_iid_log.h"

namespace thedaw::vst3 {
namespace {

constexpr const wchar_t* kWindowClassName = L"theDAW_VST3_Editor";
constexpr int kMinimumEdge = 20;

std::wstring widen(const std::string& utf8) {
    if (utf8.empty()) return {};
    const int needed =
        MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<std::size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

// Ask the monitor this window is on, falling back to the system DPI. Per-monitor-v2 awareness
// is switched on by the process before any window exists, so these are physical pixels.
float scaleForWindow(HWND hwnd) {
    UINT dpi = 0;
    if (hwnd != nullptr) dpi = GetDpiForWindow(hwnd);
    if (dpi == 0) {
        const HDC screen = GetDC(nullptr);
        if (screen != nullptr) {
            dpi = static_cast<UINT>(GetDeviceCaps(screen, LOGPIXELSX));
            ReleaseDC(nullptr, screen);
        }
    }
    if (dpi == 0) dpi = 96;
    return static_cast<float>(dpi) / 96.0f;
}

}  // namespace

Steinberg::IPlugView* tryCreatingView(Steinberg::Vst::IEditController* controller) {
    if (controller == nullptr) return nullptr;
    Steinberg::IPlugView* view = controller->createView(Steinberg::Vst::ViewType::kEditor);
    if (view == nullptr) view = controller->createView(nullptr);
    if (view == nullptr) {
        void* asView = nullptr;
        if (controller->queryInterface(Steinberg::IPlugView::iid, &asView) == Steinberg::kResultOk) {
            view = static_cast<Steinberg::IPlugView*>(asView);
        }
    }
    return view;
}

EditorWindow::~EditorWindow() { close(); }

bool EditorWindow::ensureWindowClass(std::string& error) {
    static bool registered = false;
    static bool failed = false;
    if (registered) return true;
    if (failed) {
        error = "the editor window class could not be registered";
        return false;
    }

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    // CS_OWNDC keeps a device context per window, which plugin renderers that cache an HDC
    // (a lot of the GL/Direct2D ones) expect. No CS_HREDRAW/CS_VREDRAW: the plugin paints, and
    // invalidating the whole client area on every resize makes its UI flicker.
    wc.style = CS_OWNDC;
    wc.lpfnWndProc = reinterpret_cast<WNDPROC>(&EditorWindow::windowProc);
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    wc.lpszClassName = kWindowClassName;
    if (RegisterClassExW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        failed = true;
        error = "RegisterClassEx failed for the editor window";
        return false;
    }
    registered = true;
    return true;
}

long long __stdcall EditorWindow::windowProc(void* hwndRaw, unsigned int message,
                                             unsigned long long wParam, long long lParam) {
    HWND hwnd = static_cast<HWND>(hwndRaw);
    auto* self = reinterpret_cast<EditorWindow*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));

    switch (message) {
        case WM_NCCREATE: {
            auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA,
                              reinterpret_cast<LONG_PTR>(create->lpCreateParams));
            break;
        }
        case WM_CLOSE:
            if (self != nullptr) {
                self->handleClose();
                return 0;  // the instance decides when the window really goes
            }
            break;
        case WM_SIZING:
            if (self != nullptr && self->handleSizing(reinterpret_cast<void*>(lParam), wParam)) {
                return TRUE;
            }
            break;
        case WM_EXITSIZEMOVE:
            if (self != nullptr) self->handleUserResize();
            break;
        case WM_DPICHANGED:
            if (self != nullptr) {
                self->contentScale_ = static_cast<float>(LOWORD(wParam)) / 96.0f;
                self->applyContentScale();
                // Windows suggests a new frame for the new DPI; honour it, then let the plugin
                // re-report its size through resizeView if it wants a different one.
                if (auto* suggested = reinterpret_cast<RECT*>(lParam)) {
                    SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                                 suggested->right - suggested->left,
                                 suggested->bottom - suggested->top,
                                 SWP_NOZORDER | SWP_NOACTIVATE);
                }
                return 0;
            }
            break;
        // What JUCE's VST3 editor window forwards to the view: the wheel and focus. (Keys are left
        // to the plugin's own child window, as JUCE leaves them.) JUCE scales a wheel notch the same
        // way before handing it over: half the raw delta, over 256.
        case WM_MOUSEWHEEL:
            if (self != nullptr && self->view_) {
                const float distance =
                    0.5f * static_cast<float>(GET_WHEEL_DELTA_WPARAM(wParam)) / 256.0f;
                if (self->view_->onWheel(distance) == Steinberg::kResultTrue) return 0;
            }
            break;
        case WM_SETFOCUS:
            if (self != nullptr && self->view_) self->view_->onFocus(true);
            break;
        case WM_KILLFOCUS:
            if (self != nullptr && self->view_) self->view_->onFocus(false);
            break;
        case WM_ERASEBKGND:
            return 1;  // the plugin owns every pixel; erasing first only causes flicker
        default: break;
    }
    return DefWindowProcW(hwnd, message, static_cast<WPARAM>(wParam), static_cast<LPARAM>(lParam));
}

bool EditorWindow::open(Steinberg::Vst::IEditController* controller, std::uint64_t parentHwnd, int x,
                        int y, int w, int h, const std::string& title, std::string& error) {
    error.clear();
    if (isOpen()) return true;
    if (controller == nullptr) {
        error = "this plugin has no edit controller, so it has no editor";
        return false;
    }
    if (!ensureWindowClass(error)) return false;

    controller_ = ComPtr<Steinberg::Vst::IEditController>(controller);
    view_ = ComPtr<Steinberg::IPlugView>::adopt(tryCreatingView(controller_.get()));
    if (!view_) {
        error = "the plugin did not supply an editor view";
        return false;
    }
    if (view_->isPlatformTypeSupported(Steinberg::kPlatformTypeHWND) != Steinberg::kResultTrue) {
        view_.reset();
        error = "the plugin's editor does not support being hosted in an HWND";
        return false;
    }

    canResize_ = view_->canResize() == Steinberg::kResultTrue;
    scaleSupport_ = queryFor<Steinberg::IPlugViewContentScaleSupport>(view_.get());
    view_->setFrame(this);

    Steinberg::ViewRect initial{};
    if (view_->getSize(&initial) != Steinberg::kResultOk) {
        initial.right = 400;
        initial.bottom = 300;
    }
    width_ = std::max(kMinimumEdge, static_cast<int>(initial.right - initial.left));
    height_ = std::max(kMinimumEdge, static_cast<int>(initial.bottom - initial.top));

    embedded_ = parentHwnd != 0;
    ownerHwnd_ = reinterpret_cast<void*>(static_cast<std::uintptr_t>(parentHwnd));
    viewportW_ = w > 0 ? w : width_;
    viewportH_ = h > 0 ? h : height_;

    DWORD style = 0;
    DWORD exStyle = 0;
    int left = x;
    int top = y;
    int outerW = width_;
    int outerH = height_;

    if (embedded_) {
        style = WS_POPUP | WS_CLIPCHILDREN;
        exStyle = WS_EX_NOACTIVATE * 0;  // the editor must be able to take keyboard focus
    } else {
        style = canResize_ ? (WS_OVERLAPPEDWINDOW & ~WS_MAXIMIZEBOX)
                           : (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
        style |= WS_CLIPCHILDREN;
        RECT frame{0, 0, width_, height_};
        // The plugin's size is its CLIENT area; grow the outer rect so the title bar and
        // borders do not eat into the UI.
        if (AdjustWindowRectEx(&frame, style, FALSE, exStyle)) {
            outerW = frame.right - frame.left;
            outerH = frame.bottom - frame.top;
        }
        if (x == 0 && y == 0) {
            left = CW_USEDEFAULT;
            top = CW_USEDEFAULT;
        }
    }

    const std::wstring wideTitle = widen(title.empty() ? std::string("Plugin editor") : title);
    HWND hwnd = CreateWindowExW(exStyle, kWindowClassName, wideTitle.c_str(), style, left, top,
                                outerW, outerH, static_cast<HWND>(ownerHwnd_), nullptr,
                                GetModuleHandleW(nullptr), this);
    if (hwnd == nullptr) {
        view_->setFrame(nullptr);
        view_.reset();
        error = "CreateWindowEx failed for the editor window";
        return false;
    }
    hwnd_ = hwnd;
    contentScale_ = scaleForWindow(hwnd);
    // Scale before attaching: a scale-aware plugin lays its UI out during attached().
    applyContentScale();

    if (view_->attached(hwnd, Steinberg::kPlatformTypeHWND) != Steinberg::kResultOk) {
        DestroyWindow(hwnd);
        hwnd_ = nullptr;
        view_->setFrame(nullptr);
        view_.reset();
        error = "the plugin refused to attach its editor to our window";
        return false;
    }

    // Plugins routinely settle on a different size once attached.
    Steinberg::ViewRect settled{};
    if (view_->getSize(&settled) == Steinberg::kResultOk) {
        const int settledW = std::max(kMinimumEdge, static_cast<int>(settled.right - settled.left));
        const int settledH = std::max(kMinimumEdge, static_cast<int>(settled.bottom - settled.top));
        if (settledW != width_ || settledH != height_) resizeWindowToView(settledW, settledH);
    }

    if (embedded_) {
        SetWindowPos(hwnd, HWND_TOP, x, y, width_, height_, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        applyClipRegion();
    } else {
        ShowWindow(hwnd, SW_SHOWNORMAL);
    }
    UpdateWindow(hwnd);
    if (host_ != nullptr) host_->editorResized(width_, height_);
    return true;
}

void EditorWindow::close() {
    if (closing_) return;
    closing_ = true;
    if (view_) {
        // removed() first: the plugin has to let go of the HWND before it stops existing.
        view_->removed();
        view_->setFrame(nullptr);
        view_.reset();
    }
    scaleSupport_.reset();
    if (hwnd_ != nullptr) {
        HWND hwnd = static_cast<HWND>(hwnd_);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        SetWindowRgn(hwnd, nullptr, FALSE);
        DestroyWindow(hwnd);
        hwnd_ = nullptr;
    }
    controller_.reset();
    ownerHwnd_ = nullptr;
    embedded_ = false;
    closing_ = false;
}

void EditorWindow::setRect(int x, int y, int w, int h) {
    if (!embedded_ || hwnd_ == nullptr) return;
    viewportW_ = std::max(1, w);
    viewportH_ = std::max(1, h);
    // Move only: the plugin keeps its natural size and the region does the containing, exactly
    // like the offline embed path. Resizing here would fight plugins that refuse to resize.
    SetWindowPos(static_cast<HWND>(hwnd_), nullptr, x, y, 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    applyClipRegion();
}

void EditorWindow::applyClipRegion() {
    if (!embedded_ || hwnd_ == nullptr) return;
    const int clipW = std::min(viewportW_, width_);
    const int clipH = std::min(viewportH_, height_);
    if (clipW >= width_ && clipH >= height_) {
        SetWindowRgn(static_cast<HWND>(hwnd_), nullptr, TRUE);  // nothing to clip
        return;
    }
    HRGN region = CreateRectRgn(0, 0, std::max(1, clipW), std::max(1, clipH));
    if (region == nullptr) return;  // GDI refused; better unclipped than not shown at all
    if (SetWindowRgn(static_cast<HWND>(hwnd_), region, TRUE) == 0) {
        // Ownership only transfers on success, so a failure leaves the region ours to free.
        DeleteObject(region);
    }
}

void EditorWindow::applyContentScale() {
    if (scaleSupport_) {
        scaleSupport_->setContentScaleFactor(
            static_cast<Steinberg::IPlugViewContentScaleSupport::ScaleFactor>(contentScale_));
    }
}

void EditorWindow::resizeWindowToView(int width, int height) {
    width_ = std::max(kMinimumEdge, width);
    height_ = std::max(kMinimumEdge, height);
    if (hwnd_ == nullptr) return;
    HWND hwnd = static_cast<HWND>(hwnd_);

    int outerW = width_;
    int outerH = height_;
    if (!embedded_) {
        RECT frame{0, 0, width_, height_};
        const DWORD style = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE));
        const DWORD exStyle = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
        if (AdjustWindowRectEx(&frame, style, FALSE, exStyle)) {
            outerW = frame.right - frame.left;
            outerH = frame.bottom - frame.top;
        }
    }
    SetWindowPos(hwnd, nullptr, 0, 0, outerW, outerH,
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    if (embedded_) applyClipRegion();
}

Steinberg::tresult PLUGIN_API EditorWindow::queryInterface(const Steinberg::TUID wantedIid, void** obj) {
    return iidlog::seen("plug_frame", wantedIid, queryInterfaceInner(wantedIid, obj));
}

Steinberg::tresult EditorWindow::queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj) {
    if (obj == nullptr) return Steinberg::kInvalidArgument;
    *obj = nullptr;
    THEDAW_VST3_OFFER(Steinberg::IPlugFrame)
    THEDAW_VST3_OFFER(Steinberg::FUnknown)
    return Steinberg::kNoInterface;
}

Steinberg::tresult PLUGIN_API EditorWindow::resizeView(Steinberg::IPlugView* view,
                                                       Steinberg::ViewRect* newSize) {
    if (view == nullptr || newSize == nullptr || view != view_.get()) {
        return Steinberg::kInvalidArgument;
    }
    if (inResizeView_) return Steinberg::kResultOk;  // the plugin is echoing our own onSize

    const int wanted = std::max(kMinimumEdge, static_cast<int>(newSize->right - newSize->left));
    const int wantedH = std::max(kMinimumEdge, static_cast<int>(newSize->bottom - newSize->top));
    resizeWindowToView(wanted, wantedH);

    // The VST3 resize handshake: the host resizes its window and then confirms the size back to
    // the view with onSize(). Skipping the confirmation leaves plugins that lay out inside
    // onSize (most of them) drawing at the old size.
    inResizeView_ = true;
    Steinberg::ViewRect confirmed{0, 0, static_cast<Steinberg::int32>(width_),
                                  static_cast<Steinberg::int32>(height_)};
    view_->onSize(&confirmed);
    inResizeView_ = false;

    if (host_ != nullptr) host_->editorResized(width_, height_);
    return Steinberg::kResultTrue;
}

bool EditorWindow::handleSizing(void* rectPtr, unsigned long long /*edge*/) {
    if (!view_ || !canResize_ || rectPtr == nullptr || hwnd_ == nullptr) return false;
    RECT* outer = static_cast<RECT*>(rectPtr);

    HWND hwnd = static_cast<HWND>(hwnd_);
    RECT nonClient{0, 0, 0, 0};
    const DWORD style = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE));
    const DWORD exStyle = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    AdjustWindowRectEx(&nonClient, style, FALSE, exStyle);
    const int chromeW = nonClient.right - nonClient.left;
    const int chromeH = nonClient.bottom - nonClient.top;

    Steinberg::ViewRect wanted{0, 0,
                               static_cast<Steinberg::int32>((outer->right - outer->left) - chromeW),
                               static_cast<Steinberg::int32>((outer->bottom - outer->top) - chromeH)};
    if (view_->checkSizeConstraint(&wanted) != Steinberg::kResultTrue) return false;

    // The plugin may have snapped the size to something it likes; honour it while the user is
    // still dragging so the frame follows the constrained size live.
    outer->right = outer->left + (wanted.right - wanted.left) + chromeW;
    outer->bottom = outer->top + (wanted.bottom - wanted.top) + chromeH;
    return true;
}

void EditorWindow::handleUserResize() {
    if (!view_ || hwnd_ == nullptr || inResizeView_) return;
    RECT client{};
    if (!GetClientRect(static_cast<HWND>(hwnd_), &client)) return;
    const int w = client.right - client.left;
    const int h = client.bottom - client.top;
    if (w <= 0 || h <= 0 || (w == width_ && h == height_)) return;

    width_ = w;
    height_ = h;
    inResizeView_ = true;
    Steinberg::ViewRect size{0, 0, static_cast<Steinberg::int32>(w), static_cast<Steinberg::int32>(h)};
    view_->onSize(&size);
    inResizeView_ = false;
    if (host_ != nullptr) host_->editorResized(w, h);
}

void EditorWindow::handleClose() {
    // Do not tear down from inside the window procedure: the plugin is still on the stack.
    // Tell the instance, which closes us from its own message-thread turn.
    if (host_ != nullptr) host_->editorClosedByUser();
}

}  // namespace thedaw::vst3
