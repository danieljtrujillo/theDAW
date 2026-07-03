// One extracted region of the source image. Ported from
// component-extractor/src/types.ts (UIElement there; renamed here because
// Foundry already has a UIElement).
export interface ExtractedElement {
  id: string;
  label: string;
  type?: string;
  description?: string;
  tags?: string[];
  group?: string;
  shape?: string;
  polygon?: { x: number; y: number }[];
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  cropDataUrl?: string;
  cutoutDataUrl?: string;
  maskDataUrl?: string;
  displayMode: "rect" | "cutout" | "mask";
  status: "pending" | "detected" | "processing" | "labeled";
  // Set when this element was detected INSIDE a module panel (two-pass group
  // extraction); references ExtractedPanel.id.
  panelId?: string;
}

// A detected module panel (titled section containing controls). Bounds are
// normalized to the SOURCE image, like ExtractedElement.
export interface ExtractedPanel {
  id: string;
  title: string;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  cropDataUrl?: string; // the panel backplate crop (children pixels included)
  status: "detected" | "scanning" | "scanned";
}
