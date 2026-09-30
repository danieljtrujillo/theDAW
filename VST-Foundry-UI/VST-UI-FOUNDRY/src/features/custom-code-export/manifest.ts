import type { UIElement } from "../../types";
import type { Vst3Param } from "../../lib/vst3Export";
import { toggleValue } from "./parameterValues";

interface ParameterAllocation {
  slugify: (value: string) => string;
  nextCc: () => number;
  atCap: () => boolean;
}

function finiteValue(value: unknown, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

export function appendCustomCodeParams(
  element: UIElement,
  params: Vst3Param[],
  allocation: ParameterAllocation,
): void {
  const baseId = allocation.slugify(element.id);
  for (const customParam of element.params ?? []) {
    if (customParam.type !== "toggle" && customParam.type !== "number") continue;
    if (allocation.atCap()) break;
    const exported: Vst3Param = {
      id: `${baseId}-${allocation.slugify(customParam.key)}`,
      elementId: element.id,
      name: `${element.name} ${customParam.label || customParam.key}`,
      kind: customParam.type === "toggle" ? "boolean" : "continuous",
      cc: allocation.nextCc(),
    };
    if (customParam.type === "toggle") {
      exported.default = toggleValue(customParam.default ?? customParam.value);
    } else {
      const minimum = finiteValue(customParam.min, 0);
      const maximumValue = finiteValue(customParam.max, 100);
      const maximum = maximumValue === minimum ? minimum + 1 : maximumValue;
      exported.min = minimum;
      exported.max = maximum;
      exported.default = finiteValue(customParam.default, finiteValue(customParam.value, (minimum + maximum) / 2));
    }
    const targetId = element.paramBindings?.find(binding => binding.key === customParam.key)?.targetId;
    if (targetId) exported.binding = { dawTargetId: targetId };
    params.push(exported);
  }
}
