import { describe, expect, it, vi } from "vitest";
import { buildVst3Manifest, SLUGIFY_FN_SOURCE } from "../../lib/vst3Export";
import { buildIndexHtml } from "../../lib/vst3ExportUi";
import type { CanvasState, CustomParam, UIElement } from "../../types";

const canvas: CanvasState = { width: 100, height: 100, scale: 1, panX: 0, panY: 0, backgroundImage: null };

function element(params: CustomParam[]): UIElement {
  return {
    id: "surface", name: "Surface", type: "CustomCode", x: 0, y: 0, width: 100, height: 100,
    params, paramBindings: [{ key: "enabled", targetId: "vst:macro.1" }],
  };
}

function render(params: CustomParam[]) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const setParam = vi.fn();
  const runtime = {
    FOUNDRY_DESIGN: { elements: [element(params)], canvasState: canvas },
    foundryHost: { setParam },
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
    foundryApplyParam: undefined as unknown as (id: string, value: number) => void,
    __foundrySetBindValue: undefined as unknown as (id: string, value: boolean | number) => void,
  };
  document.body.innerHTML = '<div id="foundry-root"></div>';
  const script = buildIndexHtml(SLUGIFY_FN_SOURCE).match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  new Function("window", "document", script!)(runtime, document);
  const frame = document.querySelector("iframe")!;
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const send = (data: unknown, source: MessageEventSource | null = frame.contentWindow) => {
    for (const listener of listeners) listener({ data, source } as MessageEvent);
  };
  return { runtime, frame, postMessage, send, setParam };
}

describe("custom toggle export behavior", () => {
  it.each([
    [true, false, false], [false, true, true], ["false", undefined, false],
    [1, undefined, true], [0, undefined, false], ["true", undefined, true],
  ])("uses value %s and explicit default %s consistently", (value, defaultValue, expected) => {
    const param: CustomParam = { key: "enabled", label: "Enabled", type: "toggle", value, default: defaultValue };
    const manifest = buildVst3Manifest([element([param])], canvas, "Synthetic");
    expect(manifest.params[0].default).toBe(expected);
    expect(manifest.params[0].binding).toEqual({ dawTargetId: "vst:macro.1" });
    expect(manifest.bindings[0].paramId).toBe(manifest.params[0].id);
  });

  it("initializes string toggles as booleans", () => {
    const { frame } = render([{ key: "enabled", label: "Enabled", type: "toggle", value: "false" }]);
    expect(frame.srcdoc).toContain('window.PARAMS={"enabled":false}');
  });

  it("sends host booleans to the iframe and replays automation at ready", () => {
    const { runtime, postMessage, send } = render([{ key: "enabled", label: "Enabled", type: "toggle", value: false }]);
    runtime.foundryApplyParam("surface-enabled", 0.5);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled: true } }, "*");
    postMessage.mockClear();
    send({ type: "foundry:ready" });
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled: true } }, "*");
    runtime.foundryApplyParam("surface-enabled", 0.49);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled: false } }, "*");
  });

  it("keeps bound boolean values typed and replays bindings at ready", () => {
    const { runtime, postMessage, send } = render([{ key: "enabled", label: "Enabled", type: "toggle", value: false }]);
    runtime.__foundrySetBindValue("vst:macro.1", 100);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled: true } }, "*");
    postMessage.mockClear();
    send({ type: "foundry:ready" });
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled: true } }, "*");
    runtime.__foundrySetBindValue("vst:macro.1", false);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled: false } }, "*");
  });

  it.each([true, false, "true", "false", 1, 0])("roundtrips iframe toggle %s through host and binding", (value) => {
    const { send, setParam, runtime, postMessage } = render([{ key: "enabled", label: "Enabled", type: "toggle", value: false }]);
    const enabled = value === true || value === "true" || value === 1;
    send({ type: "foundry:paramChanged", key: "enabled", value });
    expect(setParam).toHaveBeenLastCalledWith("surface-enabled", enabled ? 1 : 0);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled } }, "*");
    runtime.foundryApplyParam("surface-enabled", enabled ? 1 : 0);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { enabled } }, "*");
  });

  it("keeps numeric ranges and rejects unrelated frame messages", () => {
    const { runtime, postMessage, send, setParam } = render([{ key: "amount", label: "Amount", type: "number", value: 50, min: 20, max: 80 }]);
    runtime.foundryApplyParam("surface-amount", 0.5);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "foundry:setParams", params: { amount: 50 } }, "*");
    send({ type: "foundry:paramChanged", key: "amount", value: 65 });
    expect(setParam).toHaveBeenLastCalledWith("surface-amount", 0.75);
    setParam.mockClear();
    send({ type: "foundry:paramChanged", key: "amount", value: 80 }, window);
    send({ type: "foundry:paramChanged", key: "toString", value: 80 });
    expect(setParam).not.toHaveBeenCalled();
  });
});
