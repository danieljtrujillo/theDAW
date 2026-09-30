import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExtractTray from "../../components/extractor/ExtractTray";
import type { ExtractedElement, ExtractedPanel } from "../../lib/extractor/types";

afterEach(cleanup);

const panel: ExtractedPanel = { id: "filter", title: "Filter module", xmin: 0, ymin: 0, xmax: 1, ymax: 1, status: "scanned", cropDataUrl: "data:image/png;base64,c3ludGhldGlj" };
const member: ExtractedElement = { id: "cutoff", panelId: panel.id, label: "Cutoff", type: "knob", xmin: 0.1, ymin: 0.1, xmax: 0.2, ymax: 0.2, displayMode: "rect", status: "labeled", cropDataUrl: panel.cropDataUrl };
const noAction = () => undefined;
const actions = { onDelete: noAction, onUpdate: noAction, onEditMask: noAction, onAddToDesign: noAction, onAddAsTextures: noAction, onMakeControls: noAction, onReprocess: noAction, sensitivity: 0.5 };

describe("extractor module cards", () => {
  it("disables per-piece processing while a provider model is unavailable", () => {
    render(<ExtractTray {...actions} canProcess={false} elements={[{ ...member, panelId: undefined }]} panels={[]} onPlaceModule={noAction} onDeletePanel={noAction} />);
    expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("starts collapsed and places the complete module with chosen control types", () => {
    const placeModule = vi.fn();
    render(<ExtractTray {...actions} elements={[member]} panels={[panel]} onPlaceModule={placeModule} onDeletePanel={noAction} />);
    expect(screen.getByText("Modules (1)")).toBeTruthy();
    expect(screen.queryByLabelText("Element label")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit pieces of module Filter module" }));
    expect((screen.getByLabelText("Element label") as HTMLInputElement).value).toBe("Cutoff");
    const controlSelect = screen.getByRole("combobox");
    fireEvent.change(controlSelect, { target: { value: "Slider" } });
    fireEvent.click(screen.getByRole("button", { name: "Place as Group" }));
    expect(placeModule).toHaveBeenCalledExactlyOnceWith(panel, [{ el: member, controlType: "Slider" }]);
  });

  it("disables placement until every member is processed", () => {
    const { rerender } = render(<ExtractTray {...actions} elements={[]} panels={[panel]} onPlaceModule={noAction} onDeletePanel={noAction} />);
    expect((screen.getByRole("button", { name: "Place as Group" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ExtractTray {...actions} elements={[{ ...member, status: "pending" }]} panels={[panel]} onPlaceModule={noAction} onDeletePanel={noAction} />);
    expect((screen.getByRole("button", { name: "Place as Group" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ExtractTray {...actions} elements={[member]} panels={[panel]} onPlaceModule={noAction} onDeletePanel={noAction} />);
    expect((screen.getByRole("button", { name: "Place as Group" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a removed module's pieces as loose captures without losing them", () => {
    function ModulesWorkspace() {
      const [panels, setPanels] = useState([panel]);
      return <ExtractTray {...actions} elements={[member]} panels={panels} onPlaceModule={noAction}
        onDeletePanel={(id) => setPanels((previous) => previous.filter((entry) => entry.id !== id))} />;
    }
    render(<ModulesWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Delete module Filter module" }));
    expect(screen.queryByText("Modules (1)")).toBeNull();
    expect(screen.getByText("Individual Pieces (1)")).toBeTruthy();
    expect((screen.getByLabelText("Element label") as HTMLInputElement).value).toBe("Cutoff");
    expect(screen.getByText("Captured Assets (1)")).toBeTruthy();
  });
});
