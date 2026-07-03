import { CustomParam, CustomParamType } from "../types";

const PARAM_TYPES: CustomParamType[] = [
  "number",
  "color",
  "select",
  "toggle",
  "text",
];

// Coerce an arbitrary value into something valid for the given param type, so a
// malformed schema can never feed a bad value into the UI or the iframe.
function coerceValue(
  type: CustomParamType,
  value: unknown,
): number | string | boolean {
  switch (type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case "toggle":
      if (typeof value === "boolean") return value;
      // A string like "false"/"0" is truthy, so parse it explicitly rather
      // than relying on !! (which would turn "false" into true).
      if (typeof value === "string") return /^(true|1|yes|on)$/i.test(value.trim());
      return !!value;
    case "color":
      return typeof value === "string" ? value : "#ffffff";
    case "select":
    case "text":
    default:
      if (typeof value === "string") return value;
      return value == null ? "" : String(value);
  }
}

// Validate/normalize a parameter schema coming from an untrusted source (an
// iframe self-registering via window.foundryRegisterParams, or older/hand-built
// data). Drops malformed entries, dedupes keys, and guarantees the shape the UI
// and the iframe bridge rely on (e.g. options is always a string[]). Prevents
// crashes like calling .join() on a non-array `options`.
export function sanitizeCustomParams(raw: unknown): CustomParam[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomParam[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    const key =
      typeof r.key === "string" ? r.key.replace(/[^a-zA-Z0-9_$]/g, "") : "";
    if (!key || seen.has(key)) continue;

    const type = (PARAM_TYPES as string[]).includes(r.type as string)
      ? (r.type as CustomParamType)
      : "text";
    const label = typeof r.label === "string" && r.label.trim() ? r.label : key;

    const param: CustomParam = {
      key,
      label,
      type,
      value: coerceValue(type, r.value),
    };

    if (typeof r.id === "string") param.id = r.id;

    if (type === "number") {
      if (Number.isFinite(r.min)) param.min = r.min as number;
      if (Number.isFinite(r.max)) param.max = r.max as number;
      if (Number.isFinite(r.step)) param.step = r.step as number;
      if (typeof param.value === "number") {
        const invertedRange =
          param.min !== undefined &&
          param.max !== undefined &&
          param.min > param.max;
        if (!invertedRange) {
          if (param.min !== undefined && param.value < param.min)
            param.value = param.min;
          if (param.max !== undefined && param.value > param.max)
            param.value = param.max;
        }
      }
    }
    if (type === "select") {
      param.options = Array.isArray(r.options)
        ? r.options.filter((o): o is string => typeof o === "string")
        : [];
      if (
        typeof param.value === "string" &&
        !param.options.includes(param.value)
      ) {
        param.value = param.options[0] ?? "";
      }
    }

    seen.add(key);
    out.push(param);
  }

  return out;
}

// Reconcile a freshly-registered schema against the element's existing params so
// a code regen (or a re-register from the running iframe) never wipes values the
// user set. The registered schema defines structure and order: its type / label
// / min / max / step / options win, and keys absent from it are pruned. For keys
// present in both, the EXISTING value is kept (re-coerced to the registered
// type/range so a stale value can't violate the new schema); the stable list id
// is preserved so React keys don't churn. New keys arrive with their registered
// values. Everything runs through sanitize so the result is always valid.
export function mergeCustomParams(
  existing: CustomParam[] | undefined,
  registered: unknown,
): CustomParam[] {
  const sanitizedRegistered = sanitizeCustomParams(registered);
  const existingByKey = new Map(
    (existing || []).map((p) => [p.key, p] as const),
  );

  return sanitizedRegistered.map((rp) => {
    const prev = existingByKey.get(rp.key);
    if (!prev) return rp;
    const [reconciled] = sanitizeCustomParams([
      { ...rp, value: prev.value, id: prev.id ?? rp.id },
    ]);
    return reconciled ?? rp;
  });
}
