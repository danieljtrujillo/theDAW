import React from "react";
import { UIElement } from "../../types";

/**
 * Shared field-change plumbing used by both PropertiesPanel and
 * CompactElementProperties. Extracted verbatim from the duplicated
 * `handleChange` implementations — behaviour is preserved exactly.
 */

export type UpdateElementsFn = (
  ids: string[],
  updates: Partial<UIElement> | ((el: UIElement) => Partial<UIElement>),
) => void;

/**
 * Parse a numeric text-input value while preserving the mid-edit editing
 * affordance: an empty string or a lone "-" (and any non-finite result) is
 * treated as "do not commit yet" and returns `null`. Callers must skip the
 * update when `null` is returned.
 */
export function parseNumericInput(value: string): number | null {
  if (value === "" || value === "-") return null;
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

/**
 * Build the shared change handler for native inputs/selects.
 *
 * `guardRange` controls whether `range` inputs go through the same
 * empty/"-"/finite guard as `number` inputs. This mirrors the two original
 * (subtly different) implementations exactly:
 *   - PropertiesPanel:            guardRange = false (range -> parseFloat)
 *   - CompactElementProperties:   guardRange = true  (range -> guarded parse)
 */
export function createFieldChangeHandler(
  elementId: string,
  onUpdateElements: UpdateElementsFn,
  options?: { guardRange?: boolean },
) {
  const guardRange = options?.guardRange ?? false;

  return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    let parsedValue: any = value;

    if (type === "number" || (type === "range" && guardRange)) {
      const num = parseNumericInput(value);
      if (num === null) return;
      parsedValue = num;
    } else if (type === "range") {
      parsedValue = parseFloat(value);
    } else if (type === "checkbox") {
      parsedValue = (e.target as HTMLInputElement).checked;
    }

    onUpdateElements([elementId], { [name]: parsedValue });
  };
}
