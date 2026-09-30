import { TOGGLE_VALUE_SOURCE } from "./parameterValues";

export const CUSTOM_CODE_RENDERER_SOURCE = TOGGLE_VALUE_SOURCE + String.raw`
  function customStyleVars(element) {
    var styles = {};
    if (element.baseColor) styles["--el-base-color"] = element.baseColor;
    if (element.activeColor) styles["--el-active-color"] = element.activeColor;
    if (element.borderColor) styles["--el-border-color"] = element.borderColor;
    if (element.textColor) styles["--el-text-color"] = element.textColor;
    if (element.opacity != null) styles["--el-opacity"] = String(num(element.opacity, 100) / 100);
    if (element.skin) styles["--el-skin"] = element.skin;
    return Object.keys(styles).map(function (key) { return key + ":" + styles[key] + ";"; }).join("");
  }

  function customScriptJson(value) {
    return JSON.stringify(value).split("<").join("\\u003c")
      .split(U2028).join("\\u2028").split(U2029).join("\\u2029");
  }

  function customDocument(element, initial) {
    return "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
      "<style>*{margin:0;padding:0;box-sizing:border-box;}" +
      "html,body{width:100%;height:100%;overflow:hidden;background:transparent;}" +
      ":root{" + customStyleVars(element) + "}" +
      "body{color:var(--el-text-color,inherit);accent-color:var(--el-active-color);}</style>" +
      "<scr" + "ipt>window.PARAMS=" + customScriptJson(initial) + ";</scr" + "ipt>" +
      "<scr" + "ipt>" + BRIDGE_SOURCE + "</scr" + "ipt>" +
      "</head><body>" + (element.customCode || "") + "</body></html>";
  }

  function customFiniteValue(value, fallback) {
    var numericValue = Number(value);
    return isFinite(numericValue) ? numericValue : fallback;
  }

  function renderCustomCode(element) {
    var box = mkBox(element);
    box.style.overflow = "hidden";
    var fit = element.customCodeFit || "scale";
    var params = Array.isArray(element.params) ? element.params : [];
    var exported = [];
    var initial = Object.create(null);
    params.forEach(function (param) {
      if (!param || !param.key) return;
      initial[param.key] = param.type === "toggle" ? foundryToggleValue(param.value) : param.value;
      if (param.type !== "number" && param.type !== "toggle") return;
      var minimum = param.type === "toggle" ? 0 : customFiniteValue(param.min, 0);
      var maximum = param.type === "toggle" ? 1 : customFiniteValue(param.max, 100);
      if (maximum === minimum) maximum = minimum + 1;
      exported.push({
        key: param.key,
        paramId: foundrySlugify(element.id) + "-" + foundrySlugify(param.key),
        min: minimum, max: maximum, bool: param.type === "toggle"
      });
    });

    var iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.position = "absolute";
    iframe.style.left = "0"; iframe.style.top = "0";
    iframe.style.width = "100%"; iframe.style.height = "100%";
    iframe.style.border = "none"; iframe.style.background = "transparent";
    iframe.title = "custom-" + (element.name || element.id);
    iframe.srcdoc = customDocument(element, initial);
    box.appendChild(iframe);

    function postToFrame(message) {
      try { if (iframe.contentWindow) iframe.contentWindow.postMessage(message, "*"); } catch (error) {}
    }
    function setParamsMessage(key, value) {
      var values = Object.create(null); values[key] = value;
      return { type: "foundry:setParams", params: values };
    }

    var natural = { width: 0, height: 0 };
    function applyFit() {
      if (fit === "scale" && natural.width > 0 && natural.height > 0) {
        iframe.style.width = natural.width + "px";
        iframe.style.height = natural.height + "px";
        iframe.style.transformOrigin = "top left";
        iframe.style.transform = "scale(" +
          (num(element.width, 40) / natural.width) + "," + (num(element.height, 40) / natural.height) + ")";
      } else {
        iframe.style.width = "100%"; iframe.style.height = "100%";
        iframe.style.transform = "none";
      }
    }
    applyFit();

    var byKey = Object.create(null);
    var lastNormalized = Object.create(null);
    function applyNormalized(meta, normalized) {
      var bounded = clamp01(normalized);
      lastNormalized[meta.paramId] = bounded;
      var value = meta.bool ? bounded >= 0.5 : meta.min + bounded * (meta.max - meta.min);
      postToFrame(setParamsMessage(meta.key, value));
    }
    exported.forEach(function (meta) {
      byKey[meta.key] = meta;
      applyHandlers[meta.paramId] = function (normalized) { applyNormalized(meta, normalized); };
    });

    var bindingByKey = Object.create(null);
    var bindings = Array.isArray(element.paramBindings) ? element.paramBindings : [];
    bindings.forEach(function (binding) {
      if (!binding || !isVstBind(binding.targetId)) return;
      var meta = byKey[binding.key];
      if (!meta) return;
      bindingByKey[binding.key] = binding.targetId;
      onBindValue(binding.targetId, function (value) { applyNormalized(meta, bindPct(value) / 100); });
    });

    window.addEventListener("message", function (event) {
      if (!iframe.contentWindow || event.source !== iframe.contentWindow) return;
      var message = event.data;
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.type === "foundry:paramChanged" && typeof message.key === "string") {
        var meta = byKey[message.key];
        if (!meta) return;
        var normalized = meta.bool ? (foundryToggleValue(message.value) ? 1 : 0) :
          clamp01((customFiniteValue(message.value, meta.min) - meta.min) / (meta.max - meta.min));
        lastNormalized[meta.paramId] = normalized;
        sendParam(meta.paramId, normalized);
        if (bindingByKey[message.key]) vstLocalWrite(bindingByKey[message.key], normalized * 100);
      } else if (message.type === "foundry:contentSize") {
        natural.width = customFiniteValue(message.w, 0);
        natural.height = customFiniteValue(message.h, 0);
        applyFit();
      } else if (message.type === "foundry:ready") {
        exported.forEach(function (meta) {
          if (lastNormalized[meta.paramId] != null) applyNormalized(meta, lastNormalized[meta.paramId]);
        });
      }
    });
    return box;
  }
`;
