import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock("onnxruntime-web/webgpu", () => ({
  env: { wasm: {} },
  InferenceSession: { create: runtime.create },
  Tensor: class {
    constructor(public type: string, public data: Float32Array, public dims: number[]) {}
  },
}));
vi.mock("idb-keyval", () => ({ get: runtime.get, set: runtime.set }));

function syntheticCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  return canvas;
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("navigator", { gpu: {} });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  runtime.get.mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: vi.fn(), putImageData: vi.fn(),
    getImageData: (_left: number, _top: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255), width, height,
    }),
  })) as unknown as HTMLCanvasElement["getContext"]);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("LaMa fallback integration", () => {
  it.each(["read", "write", "both"])("forces WASM when storage %s throws", async (failure) => {
    const storageFailure = () => { throw new Error("Storage blocked"); };
    if (failure !== "write") vi.mocked(localStorage.getItem).mockImplementation(storageFailure);
    if (failure !== "read") vi.mocked(localStorage.setItem).mockImplementation(storageFailure);
    const gpu = { run: vi.fn().mockRejectedValue(new Error("WebGPU FFC kernel failed")), release: vi.fn().mockResolvedValue(undefined), outputNames: ["output"] };
    const wasm = { run: vi.fn().mockResolvedValue({ output: { data: new Float32Array(3 * 512 * 512) } }), release: vi.fn(), outputNames: ["output"] };
    runtime.create.mockResolvedValueOnce(gpu).mockResolvedValue(wasm);
    const { getSession, removeObject } = await import("../../lib/inpaint/lamaOnnx");
    expect(await removeObject(syntheticCanvas(), syntheticCanvas())).toBeInstanceOf(HTMLCanvasElement);
    expect(runtime.create.mock.calls.map(([, options]) => options.executionProviders)).toEqual([["webgpu", "wasm"], ["wasm"]]);
    expect(await getSession()).toBe(wasm);
    expect(gpu.release).toHaveBeenCalledTimes(1);
    expect(wasm.run).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
