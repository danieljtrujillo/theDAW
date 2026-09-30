export const TOGGLE_VALUE_SOURCE = `function foundryToggleValue(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  if (typeof value !== "number" && typeof value !== "string") return false;
  var numericValue = Number(value);
  return isFinite(numericValue) && numericValue >= 0.5;
}`;

export const toggleValue = new Function(`${TOGGLE_VALUE_SOURCE}; return foundryToggleValue;`)() as
  (value: unknown) => boolean;
