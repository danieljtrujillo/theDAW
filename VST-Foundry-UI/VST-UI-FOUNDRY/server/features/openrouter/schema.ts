export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).map(([keyword, value]) => {
    if (keyword === 'type' && typeof value === 'string') return [keyword, value.toLowerCase()];
    if (keyword === 'properties' && isRecord(value)) {
      return [keyword, Object.fromEntries(Object.entries(value).map(([property, definition]) => [property, toJsonSchema(definition)]))];
    }
    return [keyword, keyword === 'items' ? toJsonSchema(value) : value];
  }));
}

export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = Math.min(...[trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0));
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
    if (Number.isFinite(start) && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Response was not valid JSON');
  }
}
