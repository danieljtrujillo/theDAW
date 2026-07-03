# Styling and Themes

VST Foundry's power lies in its flexible styling system, allowing you to rapidly iterate on the visual identity of your plugin.

## Design Variants

Instead of manually building complex CSS for every knob, VST Foundry uses **Variants**. A variant defines the architectural style of a component.

- **Modernism:** Clean, flat, high-contrast.
- **Neumorphic:** Soft, extruded UI that looks like physical plastic or rubber.
- **Brutalist:** High-contrast borders, sharp shadows, and bold typography.
- **Classic:** Photorealistic or semi-skeuomorphic analog gear styles.
- **Minimal:** Ultra-clean, single-pixel lines.

You can mix and match variants, but sticking to one or two per UI usually yields the best results.

## The Color System

Each element uses a localized color palette:
- **Base Color:** The background or body color.
- **Active Color:** The accent color (e.g., the fill level of a knob, the active state of a button).
- **Text Color:** Label and value colors.
- **Border Color:** Outline colors.

*Tip:* Use the **Transparent Base** toggle in the Properties Panel to remove the base color, allowing the canvas background or underlying panels to show through.

## Glow and FX

You can enable **Glow** on any element. This is useful for active states, meters, custom hardware panels, or creating a highly polished cyberpunk aesthetic.
- **Active Only:** The glow will only appear when a toggle is ON or when actively interacting with a control (e.g., turning a dial, moving a slider).
- **Intensity & Styles:** Customize the glow with specific visual styles, adjust the glow opacity, or assign custom CSS gradients:
  - **Outer Glow:** Standard outward emissive light. Uses CSS box-shadow for UI components, and contoured CSS drop-shadows for transparent image assets.
  - **Inner Glow:** Precise edge inset shadows. For transparent image assets, utilizes a smart custom masked clipping system to wrap the inner glow along the image's non-transparent pixel boundary.
  - **Center Glow:** Creates a volumetric background radial-gradient glow centered behind the element, ideal for vintage indicator hardware backlighting.
- **Glow Spread:** Adjust the spread size of the glow directly using a dedicated pixel spread slider (0-100px) that works flawlessly for all styles.
- **Contoured Image Glows:** For static and decorative PNG assets with transparent backdrops (including assets with their backgrounds key-extracted in-app), VST Foundry uses an advanced pixel-contour analyzer. Rather than projecting a standard box-shadow on the element's bounding box, it uses CSS filters to project a beautiful contoured drop-shadow that wraps perfectly around the image shape.
- **Continuous Animations (Non-Interactive FX):** Elements support custom continuous visual effects that run constantly:
  - **Pulsing (Continuous):** Regular interactive-like pulsing glow.
  - **Breathing (Slow Pulse):** A soft, slow luminosity sweep ideal for ambient lighting.
  - **Flicker (Neon Flicker):** Technical high-frequency brightness staggers imitating authentic vintage hardware neon tubes.
  - **Floating / Bobbing:** A soft vertical floating oscillation.
  - **Orbital Glow:** Slow rotational spin of the glow and background textures.

## Global Themes

In the Settings modal (gear icon), you can apply global themes to the VST Foundry workspace itself, ensuring your editing environment matches your mood. You can also toggle accessibility features like **Colorblind Assist Mode** here.

## Texture Library

You can upload custom PNGs, JPGs, or any image into the **Asset Manager** in the left sidebar to use as textures. 
- Once uploaded, you can select any element on the canvas and go to the **Texture & Background** section in the right Properties Panel (or the **Texture** tab in the context menu).
- You can apply any uploaded image as a background texture to Knobs, Sliders, Buttons, and even Groups.
- Control how the texture interacts with the element using **Texture Opacity** and **Blend Modes** (e.g., Multiply, Overlay, Screen) for creative compositing.

## Asset Backgrounds and Image Processing

For hyper-custom UI, you can drag and drop images directly onto the canvas from the **Asset Manager**. 
- You can process these images directly in VST Foundry using the **Image** tab in the Properties Panel or context menu.
- **Layer Blend Modes:** Select from 16 different CSS blend modes (including Multiply, Screen, Overlay, Hue, Saturation, Color, Luminosity, etc.) directly on the image asset. This applies the `mix-blend-mode` property, blending the asset's layers dynamically with any elements or background patterns sitting beneath them on the canvas.
- Use the **Background Removal** tool to instantly knock out the background of an image based on a target color (or the top-left pixel) with adjustable **Tolerance** and **Feathering**.

## Reusability via Presets

Once you have styled a component perfectly (variants, colors, glow, custom properties), you can save it. In the **Raw** tab of the Properties Panel, click **Save as Custom Preset**. The component will instantly be available in the left sidebar under the **Saved Presets** category, allowing you to drag and drop identical, pre-styled components across your project.
