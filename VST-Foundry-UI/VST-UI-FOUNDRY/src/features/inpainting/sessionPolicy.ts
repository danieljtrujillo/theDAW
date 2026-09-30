type ExecutionProvider = "webgpu" | "wasm";

interface ReleasableSession {
  release(): Promise<void>;
}

interface SessionPolicyOptions<Session extends ReleasableSession, Progress> {
  create: (providers: ExecutionProvider[], onProgress?: (progress: Progress) => void) => Promise<Session>;
  hasWebGpu: () => boolean;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
}

const WEBGPU_DISABLED_KEY = "foundry:lamaDisableWebGpu";

export function isWebGpuRunFailure(error: unknown): boolean {
  const message = String(
    typeof error === "object" && error !== null && "message" in error ? error.message : error ?? "",
  ).toLowerCase();
  return message.includes("webgpu") || message.includes("kernel") || message.includes("ffc");
}

export function createSessionPolicy<Session extends ReleasableSession, Progress = never>(
  options: SessionPolicyOptions<Session, Progress>,
) {
  let forcedWasm = false;
  let current: { promise: Promise<Session>; usesWebGpu: boolean } | undefined;
  let runQueue = Promise.resolve();

  function prefersWasm(): boolean {
    if (forcedWasm) return true;
    try {
      return options.storage?.().getItem(WEBGPU_DISABLED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function rememberWasm(): void {
    forcedWasm = true;
    try {
      options.storage?.().setItem(WEBGPU_DISABLED_KEY, "1");
    } catch {}
  }

  function cacheSession(promise: Promise<Session>, usesWebGpu: boolean): Promise<Session> {
    const record = { promise, usesWebGpu };
    current = record;
    record.promise = promise.catch((error: unknown) => {
      if (current === record) current = undefined;
      throw error;
    });
    return record.promise;
  }

  function getSession(onProgress?: (progress: Progress) => void): Promise<Session> {
    if (current) return current.promise;
    const usesWebGpu = options.hasWebGpu() && !prefersWasm();
    return cacheSession(
      Promise.resolve().then(() => options.create(usesWebGpu ? ["webgpu", "wasm"] : ["wasm"], onProgress)),
      usesWebGpu,
    );
  }

  function fallbackToWasm(session: Session, onProgress?: (progress: Progress) => void): Promise<Session> {
    rememberWasm();
    return cacheSession((async () => {
      try {
        await session.release();
      } catch {}
      return options.create(["wasm"], onProgress);
    })(), false);
  }

  function run<Result>(
    operation: (session: Session) => Promise<Result>,
    onProgress?: (progress: Progress) => void,
  ): Promise<Result> {
    const result = runQueue.then(async () => {
      const session = await getSession(onProgress);
      const usesWebGpu = current?.usesWebGpu === true;
      try {
        return await operation(session);
      } catch (error) {
        if (!usesWebGpu || !isWebGpuRunFailure(error)) throw error;
        const fallback = await fallbackToWasm(session, onProgress);
        return operation(fallback);
      }
    });
    runQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  return { getSession, run };
}
