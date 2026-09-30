import type { UIElement } from "../../types";

type NumericProperty = { [Property in keyof UIElement]-?: NonNullable<UIElement[Property]> extends number ? Property : never }[keyof UIElement];
type TextProperty = { [Property in keyof UIElement]-?: string extends UIElement[Property] ? Property : never }[keyof UIElement];

const numericProperties: readonly NumericProperty[] = [
  "x", "y", "width", "height", "rotation", "opacity", "glowOpacity", "glowAmount", "glowSpread",
];
const textProperties: readonly TextProperty[] = [
  "name", "label", "baseColor", "activeColor", "textColor", "borderColor", "glowColor", "glowGradient",
];

function choiceUpdate<Property extends keyof UIElement>(
  name: Property, value: string, options: readonly UIElement[Property][],
): Partial<UIElement> | null {
  const choice = options.find((option) => option === value);
  return choice === undefined ? null : { [name]: choice };
}

export function propertyUpdate(name: string, value: string): Partial<UIElement> | null {
  const numericProperty = numericProperties.find((property) => property === name);
  if (numericProperty) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return { [numericProperty]: parsed };
  }
  const textProperty = textProperties.find((property) => property === name);
  if (textProperty) return { [textProperty]: value };
  switch (name) {
    case "glowStyle": return choiceUpdate(name, value, ["outer", "inner", "center", "solid", "neon", "radial"]);
    case "effect": return choiceUpdate(name, value, ["none", "pulsing", "breathing", "flickering", "orbital", "floating", "audioReactive"]);
    case "textureSize": return choiceUpdate(name, value, ["cover", "contain", "auto", "100% 100%"]);
    case "textureRepeat": return choiceUpdate(name, value, ["no-repeat", "repeat", "repeat-x", "repeat-y"]);
    default: return null;
  }
}
