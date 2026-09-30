import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PropertiesPanel from "../../components/PropertiesPanel";
import type { PropertiesPanelProps } from "../../components/PropertiesPanel";
import AlignmentPanel from "./AlignmentPanel";
import type { CanvasState, UIElement } from "../../types";

const canvasState: CanvasState = {
  width: 800, height: 600, backgroundImage: null, scale: 1, panX: 0, panY: 0,
};
const element = (id: string, updates: Partial<UIElement> = {}): UIElement => ({
  id, name: id, type: "Button", x: 20, y: 10, width: 40, height: 20, ...updates,
});

afterEach(cleanup);

describe("editor properties", () => {
  it("centers a grouped child in its parent dimensions", () => {
    const parent = element("group", { type: "Group", x: 100, y: 80, width: 200, height: 100 });
    const child = element("child", { groupId: parent.id });
    const onUpdateElements = vi.fn();
    const props = { selectedElements: [child], elements: [parent, child], canvasState, onUpdateElements };
    render(<AlignmentPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Center on Canvas|Center in Group/ }));
    expect(onUpdateElements).toHaveBeenCalledWith([child.id], expect.objectContaining({ x: 78, y: 38 }));
  });

  it("aligns mixed group and root selections in canvas space", () => {
    const parent = element("group", { type: "Group", x: 100 });
    const child = element("child", { groupId: parent.id, x: 10 });
    const root = element("root", { x: 30 });
    const onUpdateElements = vi.fn();
    const props = { selectedElements: [child, root], elements: [parent, child, root], canvasState, onUpdateElements };
    render(<AlignmentPanel {...props} />);
    fireEvent.click(screen.getByTitle("Align Left"));
    const [ids, update] = onUpdateElements.mock.calls[0];
    expect(ids).toContain(child.id);
    expect(typeof update === "function" ? update(child) : update).toMatchObject({ x: -72 });
  });

  it("prevents color and texture edits on a locked element while allowing unlock", () => {
    const onUpdateElements = vi.fn();
    const selected = element("locked", { isLocked: true, glow: true, textureId: "old" });
    const { container } = render(<PropertiesPanel
      selectedElements={[selected]} canvasState={canvasState} onUpdateElements={onUpdateElements}
      textures={[{ id: "new", name: "Synthetic texture", url: "data:image/png;base64," }]}
    />);
    fireEvent.change(container.querySelector('input[name="activeColor"][type="text"]')!, { target: { value: "#123456" } });
    fireEvent.click(screen.getByText("Texture & Background"));
    fireEvent.click(screen.getByTitle("Synthetic texture"));
    fireEvent.click(screen.getByText("Clear"));
    expect(onUpdateElements).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Unlock Element"));
    expect(onUpdateElements).toHaveBeenCalledWith([selected.id], { isLocked: false });
  });

  it("preserves fractional transform values", () => {
    const onUpdateElements = vi.fn();
    const { container } = render(<PropertiesPanel selectedElements={[element("child")]}
      canvasState={canvasState} onUpdateElements={onUpdateElements} />);
    fireEvent.change(container.querySelector('input[name="x"]')!, { target: { value: "12.75" } });
    expect(onUpdateElements).toHaveBeenCalledWith(["child"], { x: 12.75 });
  });

  it("keeps empty, multiple-selection and info views available through the compatibility export", () => {
    const props: PropertiesPanelProps = { selectedElements: [], canvasState, onUpdateElements: vi.fn() };
    const { rerender } = render(<PropertiesPanel {...props} />);
    expect(screen.getByText("Select an element on the canvas to edit its properties.")).toBeTruthy();
    rerender(<PropertiesPanel {...props} selectedElements={[element("first"), element("second")]} />);
    expect(screen.getByText("2 elements selected")).toBeTruthy();
    rerender(<PropertiesPanel {...props} selectedElements={[element("knob", { type: "Knob" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByText(/A rotational control/)).toBeTruthy();
    expect(screen.getByText('[data-element-id="knob"]')).toBeTruthy();
  });

  it("retains context sections, glow controls and typed animation selections", () => {
    const onUpdateElements = vi.fn();
    const { container } = render(<PropertiesPanel selectedElements={[element("button", { glow: true, glowStyle: "solid" })]}
      canvasState={canvasState} onUpdateElements={onUpdateElements} isContext />);
    for (const name of ["name", "label", "x", "y", "width", "height", "rotation", "opacity", "baseColor", "activeColor", "textColor", "borderColor", "glowOpacity", "glowAmount", "glowSpread", "glowColor", "glowGradient"]) {
      expect(container.querySelector(`input[name="${name}"]`), name).not.toBeNull();
    }
    fireEvent.change(container.querySelector('input[name="glowAmount"]')!, { target: { value: "75" } });
    expect(onUpdateElements).toHaveBeenLastCalledWith(["button"], { glowAmount: 75 });
    fireEvent.click(screen.getByText("Outer Glow"));
    fireEvent.click(screen.getByText("Inner Glow"));
    expect(onUpdateElements).toHaveBeenLastCalledWith(["button"], { glowStyle: "inner" });
    fireEvent.click(screen.getByText("None"));
    fireEvent.click(screen.getByText("Pulsing (Continuous)"));
    expect(onUpdateElements).toHaveBeenLastCalledWith(["button"], { effect: "pulsing" });
  });

  it("retains texture selection, clearing, enum settings and range controls", () => {
    const onUpdateElements = vi.fn();
    const { container } = render(<PropertiesPanel selectedElements={[element("textured", { textureId: "old" })]}
      canvasState={canvasState} onUpdateElements={onUpdateElements} isContext
      textures={[{ id: "new", name: "Synthetic texture", url: "data:image/png;base64," }]} />);
    fireEvent.click(screen.getByTitle("Synthetic texture"));
    expect(onUpdateElements).toHaveBeenLastCalledWith(["textured"], { textureId: "new" });
    fireEvent.click(screen.getByText("Cover"));
    fireEvent.click(screen.getByText("Contain"));
    expect(onUpdateElements).toHaveBeenLastCalledWith(["textured"], { textureSize: "contain" });
    fireEvent.click(screen.getByText("No Repeat"));
    fireEvent.click(screen.getByText("Repeat X"));
    expect(onUpdateElements).toHaveBeenLastCalledWith(["textured"], { textureRepeat: "repeat-x" });
    fireEvent.change(container.querySelector('input[type="range"][max="400"]')!, { target: { value: "150" } });
    expect(onUpdateElements).toHaveBeenLastCalledWith(["textured"], { textureScale: 150 });
    fireEvent.click(screen.getByText("Clear"));
    expect(onUpdateElements).toHaveBeenLastCalledWith(["textured"], { textureId: undefined });
  });

  it("blocks descendant editing and alignment when the parent group is locked", () => {
    const group = element("group", { type: "Group", isLocked: true });
    const child = element("child", { groupId: group.id });
    const onUpdateElements = vi.fn();
    const props: PropertiesPanelProps = { selectedElements: [child], elements: [group, child], canvasState, onUpdateElements };
    const { container } = render(<PropertiesPanel {...props} />);
    fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: "changed" } });
    fireEvent.click(screen.getByTitle("Align Left"));
    fireEvent.click(screen.getByTitle("Lock Element"));
    expect(onUpdateElements).not.toHaveBeenCalled();
  });
});
