// The plugin's editor, in a window of ours.
//
// Two modes, both message-thread only:
//   floating  (parentHwnd == 0) — a titled top-level window, resizable only when the plugin
//                                 says it can be; its close button ends the editor session.
//   embedded  (parentHwnd != 0) — a borderless popup OWNED by the app's window (owner, never
//                                 WS_CHILD: forcing a plugin UI into a child of a foreign
//                                 window crashes a good number of them), moved to the rect the
//                                 app gives us and clipped to it with a window region, so an
//                                 oversized editor is contained instead of covering the app.
//                                 This mirrors what backend/modules/vst/win_embed.py already
//                                 does for the offline editor path.
//
// We never touch any window we did not create. A plugin's preset browsers, menus and tooltips
// are its own top-level windows; they stay unclipped and unowned.
#pragma once

#include <cstdint>
#include <string>

#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"

#include "vst3_common.h"

namespace thedaw::vst3 {

// Implemented by the plugin instance. Always called on the message thread.
// The plugin's editor view, asked for the three ways JUCE's VST3 host asks (tryCreatingView):
// createView("editor"), then createView(nullptr), then the controller itself as an IPlugView.
// Some plugins only answer the second or third. Returns an owning pointer (ref-count 1) or null.
Steinberg::IPlugView* tryCreatingView(Steinberg::Vst::IEditController* controller);

class EditorHost {
public:
    virtual ~EditorHost() = default;
    virtual void editorResized(int width, int height) = 0;  // physical px
    virtual void editorClosedByUser() = 0;
};

class EditorWindow final : public Steinberg::IPlugFrame, public HostObject {
public:
    explicit EditorWindow(EditorHost* host) : host_(host) {}
    ~EditorWindow() override;

    // Message thread. False + `error` when the plugin has no editor or refuses an HWND.
    bool open(Steinberg::Vst::IEditController* controller, std::uint64_t parentHwnd, int x, int y,
              int w, int h, const std::string& title, std::string& error);
    void close();
    bool isOpen() const { return view_.get() != nullptr; }

    // Embedded mode: (x, y) is where the editor's top-left goes and (w, h) is the visible
    // viewport it is clipped to, both in physical screen px. No-op while floating.
    void setRect(int x, int y, int w, int h);

    int width() const { return width_; }
    int height() const { return height_; }

    // ---- FUnknown ----
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE;
    THEDAW_VST3_REFCOUNT(HostObject)

    // ---- IPlugFrame ----
    Steinberg::tresult PLUGIN_API resizeView(Steinberg::IPlugView* view,
                                             Steinberg::ViewRect* newSize) SMTG_OVERRIDE;

private:
    Steinberg::tresult queryInterfaceInner(const Steinberg::TUID wantedIid, void** obj);

    static long long __stdcall windowProc(void* hwnd, unsigned int message, unsigned long long wParam,
                                          long long lParam);
    static bool ensureWindowClass(std::string& error);

    void applyContentScale();
    void applyClipRegion();
    void resizeWindowToView(int width, int height);
    void handleClose();
    bool handleSizing(void* rectPtr, unsigned long long edge);
    void handleUserResize();

    EditorHost* host_ = nullptr;
    ComPtr<Steinberg::Vst::IEditController> controller_;
    ComPtr<Steinberg::IPlugView> view_;
    ComPtr<Steinberg::IPlugViewContentScaleSupport> scaleSupport_;

    void* hwnd_ = nullptr;
    void* ownerHwnd_ = nullptr;
    bool embedded_ = false;
    bool canResize_ = false;
    bool inResizeView_ = false;  // guards the resizeView -> onSize -> resizeView loop
    bool closing_ = false;

    int width_ = 0;
    int height_ = 0;
    int viewportW_ = 0;
    int viewportH_ = 0;
    float contentScale_ = 1.0f;
};

}  // namespace thedaw::vst3
