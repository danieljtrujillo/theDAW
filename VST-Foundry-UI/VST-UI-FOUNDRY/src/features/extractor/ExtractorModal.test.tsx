import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExtractorModal from "../../components/extractor/ExtractorModal";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import type { UIElement } from "../../types";

const sourceImage = "data:image/png;base64,c3ludGhldGlj";
const noAction = () => undefined;
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));

function Workspace({ isOpen = true }: { isOpen?: boolean }) {
  const [elements, setElements] = useState<UIElement[]>([{
    id: "canvas-knob", name: "Canvas knob", type: "Knob",
    x: 0, y: 0, width: 20, height: 20,
  }]);
  useKeyboardShortcuts({
    enabled: !isOpen, elements, setElements, selectedElementIds: ["canvas-knob"],
    setSelectedElementIds: noAction, setActiveTool: noAction,
    undo: noAction, redo: noAction, cutSelection: noAction,
    copyFromKeyboard: noAction, pasteFromKeyboard: noAction,
  });
  return <>
    <output data-testid="design-count">{elements.length}</output>
    <ExtractorModal isOpen={isOpen} onClose={noAction} sourceImage={sourceImage}
      onAddAssets={noAction} onPlaceLayers={noAction} onPlaceModules={noAction}
      onAddTextures={noAction} />
  </>;
}

function drawCapture(offset: number) {
  const image = screen.getByAltText("Canvas target");
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: 100 });
  fireEvent.load(image);
  const surface = image.parentElement!;
  fireEvent.pointerDown(surface, { pointerId: 1, clientX: offset, clientY: offset });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: offset + 20, clientY: offset + 20 });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: offset + 20, clientY: offset + 20 });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/assistant/providers") return jsonResponse([
      { id: "gemini", defaultModel: "gemini-fixture" },
      { id: "openrouter", defaultModel: "text-only-fixture" },
    ]);
    if (url.startsWith("/api/assistant/models/openrouter")) return jsonResponse([
      { id: "text-only-fixture", label: "Text only", capabilities: ["chat"] },
    ]);
    if (url.startsWith("/api/assistant/models/gemini")) return jsonResponse([
      { id: "gemini-fixture", label: "Synthetic Gemini" },
    ]);
    throw new Error("Unexpected synthetic request");
  }));
  vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: noAction } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(sourceImage);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: noAction });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: noAction });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("extractor workspace regressions", () => {
  it.each(["Delete", "Backspace"])("preserves captures when %s edits sensitivity or model select", async (key) => {
    render(<Workspace />);
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gemini-fixture"));
    drawCapture(5);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(fireEvent.keyDown(screen.getByLabelText("Sensitivity: 50%"), { key })).toBe(true);
    expect(fireEvent.keyDown(screen.getByLabelText("Model"), { key })).toBe(true);
    expect(screen.getByText("Captured Assets (1)")).toBeTruthy();
    expect(screen.getByTestId("design-count").textContent).toBe("1");
  });

  it("owns only modal events and removes no captures after close", async () => {
    const listener = vi.fn();
    window.addEventListener("keydown", listener);
    try {
      const { rerender } = render(<Workspace />);
      await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gemini-fixture"));
      drawCapture(5);
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      fireEvent.keyDown(window, { key: "Delete" });
      expect(screen.getByText("Captured Assets (1)")).toBeTruthy();
      listener.mockClear();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Delete", isComposing: true });
      expect(screen.getByText("Captured Assets (1)")).toBeTruthy();
      expect(listener).not.toHaveBeenCalled();
      rerender(<Workspace isOpen={false} />);
      fireEvent.keyDown(window, { key: "Delete" });
      rerender(<Workspace />);
      await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gemini-fixture"));
      expect(screen.getByText("Captured Assets (1)")).toBeTruthy();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Delete" });
      expect(screen.getByText("Captured Assets (0)")).toBeTruthy();
      listener.mockClear();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Backspace" });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });

  it("supports additive box clicks, marquee selection, and single deletion", async () => {
    render(<Workspace />);
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gemini-fixture"));
    drawCapture(5);
    drawCapture(50);
    const captureBoxes = screen.getAllByLabelText("Delete Pending").map((button) => button.parentElement!);
    fireEvent.pointerDown(captureBoxes[0]);
    fireEvent.pointerDown(captureBoxes[1], { shiftKey: true });
    expect(screen.getByRole("button", { name: "Delete (2)" })).toBeTruthy();
    fireEvent.pointerDown(captureBoxes[0], { ctrlKey: true });
    expect(screen.getByRole("button", { name: "Delete (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete (1)" }));
    expect(screen.getByText("Captured Assets (1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    drawCapture(5);
    expect(screen.getByText("Captured Assets (1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete (1)" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Delete Pending"));
    expect(screen.getByText("Captured Assets (0)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete (1)" })).toBeNull();
  });

  it.each(["Delete", "Backspace"])("keeps design intact when %s bulk-deletes captures", async (key) => {
    const { rerender } = render(<Workspace />);
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gemini-fixture"));
    drawCapture(5);
    drawCapture(50);
    expect(screen.getByText("Captured Assets (2)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Delete (2)" }), { key });
    expect(screen.getByText("Captured Assets (0)")).toBeTruthy();
    expect(screen.getByTestId("design-count").textContent).toBe("1");
    rerender(<Workspace isOpen={false} />);
    fireEvent.keyDown(window, { key });
    expect(screen.getByTestId("design-count").textContent).toBe("0");
  });

  it("does not silently select a non-vision provider default", async () => {
    render(<Workspace />);
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gemini-fixture"));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openrouter" } });
    await waitFor(() => expect(screen.getByText("No vision models available")).toBeTruthy());
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Auto Detect" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
