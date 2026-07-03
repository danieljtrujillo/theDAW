// The `.gan` host bridge — a tiny script injected into a Foundry-exported
// index.html so the SAME renderer used by the VST3 bundle (vst3ExportUi.ts,
// RENDERER_JS) speaks theDAW/GANduit's postMessage contract instead of the
// native FoundryShell bridge (foundry-bridge.js).
//
// The renderer only couples to its host through two globals:
//   - it CALLS   window.foundryHost.setParam(id, normalized0to1)   (UI -> host)
//   - it DEFINES window.foundryApplyParam(id, normalized0to1)      (host -> UI)
//
// This bridge supplies a `.gan`-flavored window.foundryHost (posting
// {type:'updateValue', id, value} up to the parent, exactly like owl_import.py's
// composed surfaces) and forwards host->UI messages into foundryApplyParam. It
// also relays any raw {type:'updateValue'} bubbling up from a child iframe (a
// legacy .gan CustomCode surface) straight to the host, mirroring owl_import's
// relay so both control styles work.
//
// MAINTENANCE: this is embedded verbatim inside an index.html <script>, so it
// must contain NO backticks and NO `${` sequences.

export const GAN_BRIDGE_JS = `(function () {
  "use strict";
  function post(msg) {
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*"); } catch (e) {}
  }
  // UI -> host: the renderer calls this when a control moves.
  if (!window.foundryHost) {
    window.foundryHost = {
      setParam: function (id, value) { post({ type: "updateValue", id: id, value: value }); }
    };
  }
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (e.source === window.parent) {
      // host -> UI: apply automation / value echoes to the on-screen control.
      if ((d.type === "updateValue" || d.type === "applyParam" || d.type === "param") && d.id != null) {
        if (typeof window.foundryApplyParam === "function") {
          try { window.foundryApplyParam(String(d.id), Number(d.value)); } catch (_) {}
        }
      } else if (d.type === "level") {
        // Meter/level feed: broadcast DOWN to every child iframe (CustomCode
        // surfaces consume it; the native renderer ignores it).
        var frames = document.querySelectorAll("iframe");
        for (var i = 0; i < frames.length; i++) {
          try { frames[i].contentWindow.postMessage(d, "*"); } catch (_) {}
        }
      }
    } else {
      // From a child iframe (e.g. a legacy .gan CustomCode surface posting raw
      // updateValue). Relay it UP to the host, as owl_import.py's index does.
      if (d.type === "updateValue" || d.type === "x" || d.type === "y" || d.type === "trigger") {
        post(d);
      }
    }
  });
})();`;
