// Leaf module: no imports, so the analytics grammar, the JSON:API layer and the
// developer surface can all share these without creating a dependency cycle.

export function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
