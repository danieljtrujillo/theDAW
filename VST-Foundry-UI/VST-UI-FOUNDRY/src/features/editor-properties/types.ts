import type React from "react";
import type { Asset, CanvasState, Texture, UIElement } from "../../types";

export type UpdateElements = (
  ids: string[], updates: Partial<UIElement> | ((element: UIElement) => Partial<UIElement>),
) => void;

export interface AlignmentPanelProps {
  selectedElements: UIElement[];
  onUpdateElements: UpdateElements;
  canvasState: CanvasState;
  elements?: UIElement[];
}

export interface PropertiesPanelProps extends AlignmentPanelProps {
  isContext?: boolean;
  textures?: Texture[];
  assets?: Asset[];
}

export interface PropertySectionProps {
  selectedElement: UIElement;
  onUpdateElements: UpdateElements;
  handleChange: React.ChangeEventHandler<HTMLInputElement | HTMLSelectElement>;
  setChoice: (name: string, value: string) => void;
  isContext?: boolean;
}
