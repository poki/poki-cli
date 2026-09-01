import { relative } from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'

function sourceFile (file) {
  if (typeof file !== 'string') return undefined
  let path = file
  if (file.startsWith('file:')) {
    try {
      path = fileURLToPath(file)
    } catch {}
  }
  const local = relative(process.cwd(), path)
  return local.startsWith('..') ? path : local
}

function sourceLocation (failure) {
  const file = sourceFile(failure.file)
  if (file === undefined) return undefined
  const line = typeof failure.line === 'number' ? `:${failure.line}` : ''
  const column = typeof failure.column === 'number' ? `:${failure.column}` : ''
  return `${file}${line}${column}`
}

function errorText (failure) {
  const error = failure.details?.error
  const cause = error?.cause
  if (cause instanceof Error) return inspect(cause, { colors: false, depth: null })
  if (error instanceof Error) return inspect(error, { colors: false, depth: null })
  return inspect(cause ?? error, { colors: false, depth: null })
}

function escapeCommandData (value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function escapeCommandProperty (value) {
  return escapeCommandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

function githubAnnotation (failure, location) {
  if (process.env.GITHUB_ACTIONS !== 'true') return ''
  const properties = ['title=Failed test']
  const file = sourceFile(failure.file)
  if (file !== undefined) properties.push(`file=${escapeCommandProperty(file)}`)
  if (typeof failure.line === 'number') properties.push(`line=${failure.line}`)
  if (typeof failure.column === 'number') properties.push(`col=${failure.column}`)
  const message = location === undefined ? failure.name : `${failure.name} (${location})`
  return `::error ${properties.join(',')}::${escapeCommandData(message)}\n`
}

function indent (value) {
  return value.split('\n').map(line => `  ${line}`).join('\n')
}

export default async function * failuresOnlyReporter (source) {
  const failures = []
  for await (const event of source) {
    if (event.type === 'test:fail') failures.push(event.data)
  }

  const directFailures = failures.filter(failure => failure.details?.error?.failureType !== 'subtestsFailed')
  const displayedFailures = directFailures.length > 0 ? directFailures : failures
  if (displayedFailures.length === 0) {
    yield 'All tests passed.\n'
    return
  }

  yield `\nFailed tests (${displayedFailures.length}):\n`
  for (const failure of displayedFailures) {
    const location = sourceLocation(failure)
    yield githubAnnotation(failure, location)
    yield `\nFAIL ${failure.name}\n`
    if (location !== undefined) yield `  ${location}\n`
    yield `${indent(errorText(failure))}\n`
  }
}
