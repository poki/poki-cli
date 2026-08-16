import { isRecord } from '../json'
import { inputError } from '../errors'
import { csvString, writeStructured } from '../output'
import { applyListView, listViewColumns, ResourceListKind } from '../views'

export function render (value: unknown, args: Record<string, unknown>): void {
  writeStructured(value, args.format === 'json' ? 'json' : 'toon')
}

export function renderList (
  value: unknown,
  args: Record<string, unknown>,
  kind: ResourceListKind
): void {
  const view = {
    full: args.full === true,
    fields: typeof args.fields === 'string' ? args.fields : undefined
  }
  const viewed = applyListView(value, { raw: args.raw === true, ...view }, kind)
  if (args.format === 'csv') {
    const meta = isRecord(viewed) ? viewed.meta : undefined
    // A bounded --all reports truncated; an ordinary numbered page reports only
    // has_next. Both mean resources are missing, and the CSV rows carry neither
    // signal, so an incomplete export must fail closed either way.
    if (isRecord(meta) && (meta.truncated === true || meta.has_next === true)) {
      throw inputError('--format csv cannot represent pagination truncation metadata, so this incomplete result cannot be exported. Rerun as JSON or TOON to read the pagination metadata, or use --all with bounds that return a complete result.', {
        pagination: meta
      })
    }
    const data = (viewed as { data?: unknown }).data
    // An empty collection has no rows to derive a header from, so the columns
    // come from the same view definition applyListView projects the rows with.
    process.stdout.write(csvString(
      Array.isArray(data) ? data as Array<Record<string, unknown>> : [],
      listViewColumns(kind, view)
    ))
    return
  }
  render(viewed, args)
}
