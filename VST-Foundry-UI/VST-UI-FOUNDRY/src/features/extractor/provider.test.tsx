import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseExtractorModel, useExtractorProvider, type ExtractModel } from "./useExtractorProvider";

const models = (ids: string[]): ExtractModel[] => ids.map((id) => ({ id, label: id, capabilities: ["vision"] }));
const response = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => {
  vi.spyOn(Storage.prototype, "getItem").mockReturnValue(JSON.stringify({ gemini: "synthetic-google", openrouter: "synthetic-router" }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("extractor providers", () => {
  it("chooses preferences only from fetched IDs, preserving valid choices", () => {
    const catalog = models(["other/vision-fixture", "google/gemini-fixture-flash", "google/gemini-fixture-flash-lite"]);
    expect(chooseExtractorModel("openrouter", catalog, "", "missing")).toBe("google/gemini-fixture-flash-lite");
    expect(chooseExtractorModel("openrouter", catalog, "other/vision-fixture", "missing")).toBe("other/vision-fixture");
    expect(chooseExtractorModel("gemini", models(["gemini-3.5-flash-lite", "default-fixture"]), "", "default-fixture")).toBe("gemini-3.5-flash-lite");
    expect(chooseExtractorModel("gemini", models(["first-fixture", "default-fixture"]), "", "default-fixture")).toBe("default-fixture");
    expect(chooseExtractorModel("gemini", models(["first-fixture"]), "", "missing")).toBe("first-fixture");
    expect(chooseExtractorModel("openrouter", [], "", "text-only")).toBe("");
  });

  it("never mixes provider credentials/models and ignores an old provider response", async () => {
    let finishGoogle!: (value: Response) => void;
    const googleResponse = new Promise<Response>((resolve) => { finishGoogle = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/assistant/models/gemini")) return googleResponse;
      if (url.startsWith("/api/assistant/models/openrouter")) return response({ models: [
        { id: "text-fixture", capabilities: ["chat"] }, null, { id: 12 },
        ...models(["other/vision-fixture", "google/gemini-fixture-flash-lite"]),
      ] });
      if (url === "/api/assistant/providers") return response({ providers: [{ id: "openrouter", defaultModel: "text-fixture" }] });
      throw new Error("Unexpected synthetic request");
    }));
    const { result } = renderHook(() => useExtractorProvider(true));
    expect(result.current.apiKey).toBe("synthetic-google");
    act(() => result.current.setProvider("openrouter"));
    expect(result.current.apiKey).toBe("synthetic-router");
    expect(result.current.model).toBe("");
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.availableModels.map((entry) => entry.id)).toEqual(["other/vision-fixture", "google/gemini-fixture-flash-lite"]);
    expect(result.current.model).toBe("google/gemini-fixture-flash-lite");
    await act(async () => finishGoogle(response(models(["google-stale-fixture"]))));
    expect(result.current.provider).toBe("openrouter");
    expect(result.current.model).toBe("google/gemini-fixture-flash-lite");
    act(() => result.current.setModel("not-in-catalog"));
    expect(result.current.model).toBe("google/gemini-fixture-flash-lite");
  });

  it("preserves per-provider model choices through switching and reopening", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/assistant/providers") return response([]);
      if (url.startsWith("/api/assistant/models/gemini")) return response(models(["google-first", "google-selected"]));
      if (url.startsWith("/api/assistant/models/openrouter")) return response(models(["router-first", "router-selected"]));
      throw new Error("Unexpected synthetic request");
    }));
    const { result, rerender } = renderHook(({ isOpen }) => useExtractorProvider(isOpen), { initialProps: { isOpen: true } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setModel("google-selected"));
    act(() => result.current.setProvider("openrouter"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setModel("router-selected"));
    act(() => result.current.setProvider("gemini"));
    await waitFor(() => expect(result.current.model).toBe("google-selected"));
    rerender({ isOpen: false });
    rerender({ isOpen: true });
    await waitFor(() => expect(result.current.model).toBe("google-selected"));
  });

  it("recovers from storage denial and HTTP failure without inventing a model", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Synthetic denial"); });
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ isOpen }) => useExtractorProvider(isOpen), { initialProps: { isOpen: false } });
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ isOpen: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.apiKey).toBe("");
    expect(result.current.model).toBe("");
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBe("Could not load models");
    fetcher.mockImplementation(async () => response(models(["recovered-fixture"])));
    rerender({ isOpen: false });
    rerender({ isOpen: true });
    await waitFor(() => expect(result.current.model).toBe("recovered-fixture"));
  });
});
