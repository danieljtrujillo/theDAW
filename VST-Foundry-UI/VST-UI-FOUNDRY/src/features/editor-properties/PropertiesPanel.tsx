import React from "react";
import { Lock, Unlock } from "lucide-react";
import AlignmentPanel from "./AlignmentPanel";
import { IsContext, PropertiesWrapper } from "./PanelLayout";
import { IdentitySection } from "./IdentitySection";
import { TransformSection } from "./TransformSection";
import { StyleSection } from "./StyleSection";
import { EffectsSection } from "./EffectsSection";
import { TextureSection } from "./TextureSection";
import { InfoSection } from "./InfoSection";
import { isElementLocked } from "./layout";
import { propertyUpdate } from "./propertyUpdates";
import type { PropertiesPanelProps, PropertySectionProps, UpdateElements } from "./types";

export type { PropertiesPanelProps } from "./types";

export default function PropertiesPanel({
  selectedElements, elements = selectedElements, onUpdateElements, canvasState, isContext, textures = [],
}: PropertiesPanelProps) {
  const [activeTab, setActiveTab] = React.useState<"properties" | "info">("properties");
  if (selectedElements.length === 0) {
    return (
      <PropertiesWrapper isContext={isContext}>
        <div className="w-full h-full flex flex-col items-center justify-center text-app-muted p-4 text-center">
          Select an element on the canvas to edit its properties.
        </div>
      </PropertiesWrapper>
    );
  }
  const alignment = <AlignmentPanel selectedElements={selectedElements} elements={elements} onUpdateElements={onUpdateElements} canvasState={canvasState} />;
  if (selectedElements.length > 1) {
    return (
      <PropertiesWrapper isContext={isContext}>
        <div className="w-full flex flex-col">
          {alignment}
          <div className="p-4 text-center text-sm text-app-muted">
            {selectedElements.length} elements selected
            <p className="mt-2 text-xs text-app-muted">Use the layout tools or arrow keys to move them together.</p>
          </div>
        </div>
      </PropertiesWrapper>
    );
  }

  const original = selectedElements[0];
  const selectedElement = { ...original, isLocked: isElementLocked(original, elements) };
  const updateEditable: UpdateElements = (ids, updates) => {
    if (selectedElement.isLocked || !ids.includes(selectedElement.id)) return;
    onUpdateElements([selectedElement.id], updates);
  };
  const setChoice = (name: string, value: string) => {
    const updates = propertyUpdate(name, value);
    if (updates) updateEditable([selectedElement.id], updates);
  };
  const sections: PropertySectionProps = {
    selectedElement, isContext, onUpdateElements: updateEditable, setChoice,
    handleChange: (event) => setChoice(event.target.name, event.target.value),
  };
  const parentLocked = isElementLocked({ ...original, isLocked: false }, elements);

  return (
    <IsContext.Provider value={!!isContext}>
      <PropertiesWrapper isContext={isContext} extraHeader={
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <button
            onClick={() => !parentLocked && onUpdateElements([original.id], { isLocked: !original.isLocked })}
            disabled={parentLocked}
            className={`p-1 rounded ${selectedElement.isLocked ? "bg-red-900/30 text-red-400" : "text-app-muted hover:text-white hover:bg-app-surface"}`}
            title={original.isLocked ? "Unlock Element" : "Lock Element"}
          >
            {selectedElement.isLocked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
          </button>
        </div>
      }>
        <div className="flex border-b border-app-border">
          {(["properties", "info"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-2 text-xs font-medium transition-colors ${activeTab === tab ? "text-white border-b-2 border-app-main" : "text-app-muted hover:text-app-main"}`}>
              {tab === "properties" ? "Properties" : "Info"}
            </button>
          ))}
        </div>
        {activeTab === "info" ? <InfoSection selectedElement={selectedElement} /> : (
          <>
            {alignment}
            <div className={isContext ? "p-2 space-y-2" : "p-4 space-y-4"}>
              <IdentitySection {...sections} />
              <TransformSection {...sections} />
              <StyleSection {...sections} />
              <EffectsSection {...sections} />
              <TextureSection {...sections} textures={textures} />
            </div>
          </>
        )}
      </PropertiesWrapper>
    </IsContext.Provider>
  );
}
