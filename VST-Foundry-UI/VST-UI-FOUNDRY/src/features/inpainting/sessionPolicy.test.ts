import { describe, expect, it, vi } from "vitest";
import { createSessionPolicy } from "./sessionPolicy";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function session(name: string) {
  return { name, release: vi.fn().mockResolvedValue(undefined) };
}

describe("inpainting session policy", () => {
  it.each([false, true])("selects WASM without GPU or with a persisted preference (%s)", async (hasWebGpu) => {
    const create = vi.fn().mockResolvedValue(session("wasm"));
    const policy = createSessionPolicy({ create, hasWebGpu: () => hasWebGpu, storage: () => ({ getItem: () => "1", setItem: vi.fn() }) });
    await policy.getSession();
    expect(create).toHaveBeenCalledWith(["wasm"], undefined);
  });

  it("shares pending initialization and retries after its rejection", async () => {
    const pending = deferred<ReturnType<typeof session>>();
    const ready = session("gpu");
    const create = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(ready);
    const policy = createSessionPolicy({ create, hasWebGpu: () => true });
    const first = policy.getSession();
    expect(policy.getSession()).toBe(first);
    const rejected = expect(first).rejects.toThrow("init failed");
    pending.reject(new Error("init failed"));
    await rejected;
    expect(await policy.getSession()).toBe(ready);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("awaits asynchronous release and shares fallback with queued runs and session readers", async () => {
    const release = deferred<void>();
    const releaseStarted = deferred<void>();
    const gpu = session("gpu");
    gpu.release.mockImplementation(() => { releaseStarted.resolve(); return release.promise; });
    const wasm = session("wasm");
    const create = vi.fn().mockResolvedValueOnce(gpu).mockResolvedValue(wasm);
    const policy = createSessionPolicy<typeof gpu>({ create, hasWebGpu: () => true });
    const visited: string[] = [];
    const operation = async (current: typeof gpu) => {
      visited.push(current.name);
      if (current === gpu) throw new Error("WebGPU kernel failed");
      return current.name;
    };
    const firstRun = policy.run(operation);
    const secondRun = policy.run(operation);
    await releaseStarted.promise;
    const duringFallback = policy.getSession();
    expect(create).toHaveBeenCalledTimes(1);
    expect(visited).toEqual(["gpu"]);
    release.resolve();
    expect(await Promise.all([firstRun, secondRun])).toEqual(["wasm", "wasm"]);
    expect(await duringFallback).toBe(wasm);
    expect(visited).toEqual(["gpu", "wasm", "wasm"]);
    expect(gpu.release).toHaveBeenCalledTimes(1);
    expect(create.mock.calls.map(([providers]) => providers)).toEqual([["webgpu", "wasm"], ["wasm"]]);
  });

  it("handles a rejected release without losing the WASM retry", async () => {
    const gpu = session("gpu");
    gpu.release.mockRejectedValue(new Error("device already lost"));
    const wasm = session("wasm");
    const create = vi.fn().mockResolvedValueOnce(gpu).mockResolvedValue(wasm);
    const policy = createSessionPolicy({ create, hasWebGpu: () => true });
    await expect(policy.run(async (current) => {
      if (current === gpu) throw new Error("WebGPU failed");
      return "done";
    })).resolves.toBe("done");
    expect(await policy.getSession()).toBe(wasm);
  });

  it("propagates ordinary input errors without release or retry and keeps the run queue usable", async () => {
    const gpu = session("gpu");
    const create = vi.fn().mockResolvedValue(gpu);
    const policy = createSessionPolicy({ create, hasWebGpu: () => true });
    await expect(policy.run(async () => { throw new Error("wrong tensor dimensions"); })).rejects.toThrow("wrong tensor dimensions");
    expect(await policy.run(async () => "next run")).toBe("next run");
    expect(gpu.release).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries only once when the WASM run also fails", async () => {
    const create = vi.fn().mockResolvedValueOnce(session("gpu")).mockResolvedValue(session("wasm"));
    const policy = createSessionPolicy({ create, hasWebGpu: () => true });
    const operation = vi.fn(async () => { throw new Error("kernel failed"); });
    await expect(policy.run(operation)).rejects.toThrow("kernel failed");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("keeps forced WASM in memory after replacement creation fails and storage is unavailable", async () => {
    const gpu = session("gpu");
    const wasm = session("wasm");
    const create = vi.fn().mockResolvedValueOnce(gpu).mockRejectedValueOnce(new Error("allocation failed")).mockResolvedValue(wasm);
    const policy = createSessionPolicy({ create, hasWebGpu: () => true, storage: () => { throw new Error("storage denied"); } });
    await expect(policy.run(async () => { throw new Error("WebGPU failed"); })).rejects.toThrow("allocation failed");
    expect(await policy.getSession()).toBe(wasm);
    expect(create.mock.calls.map(([providers]) => providers)).toEqual([["webgpu", "wasm"], ["wasm"], ["wasm"]]);
  });
});
