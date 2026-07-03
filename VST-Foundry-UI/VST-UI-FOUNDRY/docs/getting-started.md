# Getting Started

This guide will walk you through setting up a new VST Foundry project and familiarizing yourself with the interface.

## The Workspace

The VST Foundry workspace is divided into several key areas:

### 1. The Canvas
The central area where you build your UI. You can drag and drop elements, resize them, and arrange them into your desired layout.
- **Zoom & Pan:** Use the controls at the bottom of the canvas to zoom in/out, or hold `Space` (or select the Pan tool) to move around the canvas.
- **Preview Mode:** Toggle "Preview Mode" in the top bar to interact with your controls (turn knobs, push buttons) exactly as they would behave in the final product.

### 2. The Sidebar (Left)
Contains all the tools, elements, and assets you can add to your canvas. The left sidebar is split into two toggleable panels:
- **Categories Panel:** A compact list of component categories (Knobs, Sliders, Saved Presets, Custom Code).
- **Explorer Panel:** Displays the contents of the currently selected category (the actual draggable elements) and the **Asset Manager**.
- **Assets Manager:** Manage images and background assets for your UI. Dragging an image from here onto the canvas will automatically constrain its size to the canvas while maintaining aspect ratio.

### 3. The Layers Panel (Right)
Displays a hierarchical list of all elements on your canvas.
- Reorder elements by dragging them up or down.
- Group elements for easier management.
- Select elements even if they are obscured on the canvas.

### 4. The Properties Panel (Context Menu / Floating)
When you right-click an element or select it, you can access its properties.
- Edit dimensions (X, Y, Width, Height, Rotation).
- Change design variants (Neumorphic, Brutalist, etc.).
- Adjust custom data ranges (Min/Max for knobs).
- Set colors, opacity, and corner radii.

## Creating Your First UI

1. **Set Canvas Size:** Click the "Settings" gear in the top right to define the overall dimensions of your VST plugin window (e.g., 800x600).
2. **Add a Background:** Drag an Image element or set a base background color using the canvas properties.
3. **Add Controls:** Drag a "Knob" from the left sidebar onto the canvas.
4. **Customize:** Right-click the knob. Change its variant to "Classic", set its label to "CUTOFF", and define its color palette.
5. **Test:** Click "Preview" in the top bar and try turning the knob!
