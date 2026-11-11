import { encode } from '@toon-format/toon'

import { errorDocument } from './errors'

export type StructuredFormat = 'toon' | 'json'

export function structuredFormat (value: unknown): StructuredFormat {
  return value === 'json' ? 'json' : 'toon'
}

export function structuredString (value: unknown, format: StructuredFormat = 'toon'): string {
  const output = format === 'json'
    ? JSON.stringify(value)
    : encode(value, { delimiter: '\t' })
  return output.endsWith('\n') ? output : `${output}\n`
}

export function writeStructured (value: unknown, format: StructuredFormat = 'toon'): void {
  process.stdout.write(structuredString(value, format))
}

export function requestedFormat (args: string[]): StructuredFormat {
  let format: StructuredFormat = 'toon'
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    const value = argument === '--format'
      ? args[index + 1]
      : argument.startsWith('--format=')
        ? argument.slice('--format='.length)
        : undefined
    if (value === 'json') format = 'json'
    if (value === 'toon') format = 'toon'
  }
  return format
}

// Cells are quoted per RFC 4180 but never rewritten. A leading =, +, - or @ is
// a spreadsheet formula trigger, yet the usual neutralization (an apostrophe or
// tab prefix) would change the exported value for the agents and pipelines that
// read this export back, and - alone matches every negative number.
function csvCell (value: unknown): string {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// Columns are the union of row keys in first-seen order, so every resource
// field appears even when early rows omit it. Nested values are embedded as
// JSON cells. An empty collection carries no rows to derive columns from, so
// the caller supplies the columns its view declares: writing zero bytes and
// exiting 0 is the one failure an agent cannot detect.
export function csvString (rows: Array<Record<string, unknown>>, declaredColumns: readonly string[]): string {
  const columns: string[] = rows.length === 0 ? [...declaredColumns] : []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key)
    }
  }
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(columns.map(column => csvCell(row[column])).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function writeError (error: unknown, format: StructuredFormat = 'toon'): void {
  process.stderr.write(structuredString(errorDocument(error), format))
}
