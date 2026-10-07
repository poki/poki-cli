// Every game-scoped route starts with the same encoded game segment, and the
// identifiers interpolated after it are user-supplied. Encoding each segment
// exactly once here means no route can be built with an unencoded identifier.
// Literal route text that must survive verbatim - an `@action` suffix, whose
// `@` encodeURIComponent would escape - is appended by the caller instead.
export function gamePath (game: unknown, ...segments: unknown[]): string {
  return `/games/${[game, ...segments].map(segment => encodeURIComponent(String(segment))).join('/')}`
}
