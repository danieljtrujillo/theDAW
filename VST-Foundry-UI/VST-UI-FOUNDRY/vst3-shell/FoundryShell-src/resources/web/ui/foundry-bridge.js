/*
 * foundry-bridge.js
 *
 * Native <-> web bridge for the FoundryShell iPlug2 VST3 shell.
 *
 * The native side (FoundryShell.cpp) automatically injects `IPlugSendMsg`
 * into every page. This script builds the higher level Foundry contract on
 * top of it:
 *
 *   window.foundryHost.setParam(paramId, normalized0to1)
 *       -> sends the value to the plugin (which maps paramId -> index and
 *          calls SendParameterValueFromUI, informing the host).
 *
 *   window.foundryApplyParam(paramId, normalized0to1)
 *       -> called by the page; overridden by the UI to react to host
 *          automation / preset recall. A default no-op is provided here.
 *
 * The native side pushes the manifest parameter map via
 * `window.__foundrySetParamMap(entries)` once the page has loaded, so the
 * bridge can translate between the string paramId used by the UI and the
 * integer parameter index used by iPlug2.
 */
(function () {
  "use strict";

  var indexToId = {};
  var idToIndex = {};

  // Called by the native side (see FoundryShell::PushParamMapToUI).
  // entries: [{ index, id, elementId, kind, cc }, ...] in parameter order.
  window.__foundrySetParamMap = function (entries) {
    indexToId = {};
    idToIndex = {};
    (entries || []).forEach(function (e) {
      indexToId[e.index] = e.id;
      idToIndex[e.id] = e.index;
    });
    window.foundryParamMap = entries || [];
    if (typeof window.onFoundryParamMap === "function") {
      try { window.onFoundryParamMap(window.foundryParamMap); } catch (err) { /* ignore */ }
    }
  };

  // Host object the UI uses to push a parameter value to the plugin.
  window.foundryHost = {
    // id: manifest paramId, v: normalized 0..1
    setParam: function (id, v) {
      var value = Number(v);
      if (isNaN(value)) return;
      value = Math.min(1, Math.max(0, value));
      IPlugSendMsg({
        msg: "SAMFUI",
        msgTag: 0, // kMsgTagSetParam
        ctrlTag: -1,
        data: window.btoa(JSON.stringify({ id: String(id), v: value }))
      });
    },
    // Convenience lookups for pages that need them.
    paramIndex: function (id) { return (id in idToIndex) ? idToIndex[id] : -1; },
    paramId: function (index) { return (index in indexToId) ? indexToId[index] : null; }
  };

  // Default no-op. Pages override this to react to host-side parameter changes.
  if (typeof window.foundryApplyParam !== "function") {
    window.foundryApplyParam = function (/* id, normalized */) {};
  }

  // ---- Functions invoked by the native WebViewEditorDelegate ----

  // Parameter value from delegate (host automation, preset recall, init).
  window.SPVFD = function (paramIdx, val) {
    var id = indexToId[paramIdx];
    if (id !== undefined && typeof window.foundryApplyParam === "function") {
      window.foundryApplyParam(id, val);
    }
  };

  window.SCVFD = function (/* ctrlTag, val */) {};
  window.SCMFD = function (/* ctrlTag, msgTag, dataSize, msg */) {};

  // Arbitrary message from delegate. msgTag === -1 carries the auto param-init
  // JSON blob that WebViewEditorDelegate sends on content load.
  window.SAMFD = function (msgTag, dataSize, msg) {
    if (msgTag === -1 && dataSize > 0) {
      try {
        var json = JSON.parse(window.atob(msg));
        if (json && json.id === "params") {
          window.foundryNativeParams = json.params;
        }
      } catch (err) { /* ignore malformed init blob */ }
    }
  };

  window.SMMFD = function (/* statusByte, dataByte1, dataByte2 */) {};
  window.SSMFD = function (/* offset, size, msg */) {};
})();
