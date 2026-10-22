import { CliError } from '../errors'
import { isRecord } from '../json'
import { findTable, tableCatalog, type ColumnDefinition, type DataAggregate, type TableDefinition } from './catalog'
import { recipeNamesForTable } from './examples'
import { resolvedSelectOutputName, visitSelectExpression } from './select-expression'

type Primitive = string | number | boolean

interface ResolvedField {
  table: TableDefinition
  column: ColumnDefinition
}

interface ReferenceViolation {
  path: string
  reference: string
  reason: 'unknown_top_level_table' | 'join_only_top_level_table' | 'unknown_join_source' | 'unsupported_join_source' | 'unknown_column'
  table?: string
  field?: string
}

interface SemanticViolation {
  path: string
  table: string
  field: string
  aggregate?: string
  aggregation_kind: string
  unit: string
  allowed_aggregates: string[]
  missing_dimensions: string[]
  required_dimension_options?: string[][]
  reason: string
  why_misleading: string
  safe_reformulations: string[]
  relevant_recipes: string[]
}

interface ConstraintState {
  fixed: Map<string, Primitive>
  lower: Map<string, Primitive[]>
  upper: Map<string, Primitive[]>
}

const emptyConstraints = (): ConstraintState => ({
  fixed: new Map(),
  lower: new Map(),
  upper: new Map()
})

function findColumn (table: TableDefinition, name: string): ColumnDefinition | undefined {
  return table.columns.find(column => column.name === name)
}

function fieldKey (resolved: ResolvedField): string {
  return `${resolved.table.name}.${resolved.column.name}`
}

function expandJoinEquivalentFields (from: TableDefinition, fields: Set<string>): Set<string> {
  const expanded = new Set(fields)
  for (const joined of tableCatalog.filter(table => !table.top_level && table.join_on !== undefined)) {
    const joinOn = joined.join_on as string
    if (findColumn(from, joinOn) === undefined || findColumn(joined, joinOn) === undefined) continue
    const sourceKey = `${from.name}.${joinOn}`
    const joinedKey = `${joined.name}.${joinOn}`
    if (expanded.has(sourceKey) || expanded.has(joinedKey)) {
      expanded.add(sourceKey)
      expanded.add(joinedKey)
    }
  }
  return expanded
}

function resolveKnownField (from: TableDefinition, field: string): ResolvedField | undefined {
  const separator = field.indexOf('.')
  const table = separator === -1 ? from : findTable(field.slice(0, separator))
  if (table === undefined) return undefined
  const column = findColumn(table, separator === -1 ? field : field.slice(separator + 1))
  return column === undefined ? undefined : { table, column }
}

function outputNames (query: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(query.select)) return names
  for (const statement of query.select) {
    if (!isRecord(statement)) continue
    const name = resolvedSelectOutputName(statement)
    if (name !== undefined) names.add(name)
  }
  return names
}

function referenceViolations (query: Record<string, unknown>): { from?: TableDefinition, violations: ReferenceViolation[] } {
  if (typeof query.from !== 'string') return { violations: [] }
  const from = findTable(query.from)
  if (from === undefined) {
    return {
      violations: [{
        path: 'from',
        reference: query.from,
        reason: 'unknown_top_level_table',
        table: query.from
      }]
    }
  }
  if (!from.top_level) {
    return {
      from,
      violations: [{
        path: 'from',
        reference: query.from,
        reason: 'join_only_top_level_table',
        table: query.from
      }]
    }
  }

  const aliases = outputNames(query)
  const violations: ReferenceViolation[] = []
  const check = (field: unknown, path: string, allowOutputName = false): void => {
    if (typeof field !== 'string' || (allowOutputName && !field.includes('.') && aliases.has(field))) return
    const separator = field.indexOf('.')
    const qualifier = separator === -1 ? from.name : field.slice(0, separator)
    const columnName = separator === -1 ? field : field.slice(separator + 1)
    const table = qualifier === from.name ? from : findTable(qualifier)
    if (table === undefined) {
      violations.push({ path, reference: field, reason: 'unknown_join_source', table: qualifier, field: columnName })
      return
    }
    if (table !== from && (table.top_level || table.join_on === undefined || findColumn(from, table.join_on) === undefined)) {
      violations.push({ path, reference: field, reason: 'unsupported_join_source', table: qualifier, field: columnName })
      return
    }
    if (findColumn(table, columnName) === undefined) {
      violations.push({ path, reference: field, reason: 'unknown_column', table: table.name, field: columnName })
    }
  }

  if (Array.isArray(query.select)) {
    query.select.forEach((statement, index) => {
      if (!isRecord(statement)) return
      visitSelectExpression(statement, {
        field: (field, context) => check(field, context.path)
      }, { path: `select[${index}]` })
    })
  }
  if (Array.isArray(query.group)) query.group.forEach((field, index) => check(field, `group[${index}]`, true))
  if (Array.isArray(query.order)) {
    query.order.forEach((order, index) => {
      if (isRecord(order)) check(order.field, `order[${index}].field`, true)
    })
  }
  if (isRecord(query.include)) {
    Object.keys(query.include).forEach(field => check(field, `include.${field}`, true))
  }
  if (query.where !== undefined) {
    visitSelectExpression(query.where, {
      field: (field, context) => check(field, context.path, true)
    }, { root: 'condition', path: 'where' })
  }
  return { from, violations }
}

function primitive (value: unknown): Primitive | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isRecord(value) && Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, 'constant')) {
    return primitive(value.constant)
  }
  return undefined
}

function samePrimitive (left: Primitive, right: Primitive): boolean {
  return typeof left === typeof right && left === right
}

function addBound (bounds: Map<string, Primitive[]>, field: string, value: Primitive): void {
  const values = bounds.get(field) ?? []
  if (!values.some(candidate => samePrimitive(candidate, value))) values.push(value)
  bounds.set(field, values)
}

function finalizeBounds (state: ConstraintState): ConstraintState {
  for (const [field, lowerValues] of state.lower) {
    const upperValues = state.upper.get(field) ?? []
    const exact = lowerValues.find(lower => upperValues.some(upper => samePrimitive(lower, upper)))
    if (exact !== undefined) state.fixed.set(field, exact)
  }
  return state
}

function mergeAnd (states: ConstraintState[]): ConstraintState {
  const merged = emptyConstraints()
  for (const state of states) {
    for (const [field, value] of state.fixed) {
      if (!merged.fixed.has(field)) merged.fixed.set(field, value)
    }
    for (const [field, values] of state.lower) values.forEach(value => addBound(merged.lower, field, value))
    for (const [field, values] of state.upper) values.forEach(value => addBound(merged.upper, field, value))
  }
  return finalizeBounds(merged)
}

function mergeOr (states: ConstraintState[]): ConstraintState {
  const merged = emptyConstraints()
  if (states.length === 0) return merged
  for (const [field, value] of states[0].fixed) {
    if (states.every(state => {
      const candidate = state.fixed.get(field)
      return candidate !== undefined && samePrimitive(candidate, value)
    })) {
      merged.fixed.set(field, value)
    }
  }
  return merged
}

function conditionConstraints (
  condition: unknown,
  from: TableDefinition,
  outputFields: Map<string, string | undefined> = new Map()
): ConstraintState {
  if (Array.isArray(condition)) {
    const state = emptyConstraints()
    if (condition.length !== 3 || typeof condition[1] !== 'string') return state
    const left = condition[0]
    const reference = typeof left === 'string'
      ? left
      : isRecord(left) && typeof left.field === 'string' && directFieldStatement(left) !== undefined
        ? left.field
        : undefined
    if (reference === undefined) return state
    const field = !reference.includes('.') && outputFields.has(reference)
      ? outputFields.get(reference)
      : (() => {
          const resolved = resolveKnownField(from, reference)
          return resolved === undefined ? undefined : fieldKey(resolved)
        })()
    if (field === undefined) return state
    const operator = condition[1].trim().toLowerCase()
    const right = condition[2]
    const value = primitive(right)
    if ((operator === '==' || operator === '=') && value !== undefined) state.fixed.set(field, value)
    if (operator === 'in' && Array.isArray(right) && right.length === 1) {
      const only = primitive(right[0])
      if (only !== undefined) state.fixed.set(field, only)
    }
    if (operator === '>=' && value !== undefined) addBound(state.lower, field, value)
    if (operator === '<=' && value !== undefined) addBound(state.upper, field, value)
    return finalizeBounds(state)
  }
  if (!isRecord(condition) || !Array.isArray(condition.expressions)) return emptyConstraints()
  const states = condition.expressions.map(expression => conditionConstraints(expression, from, outputFields))
  return String(condition.operator ?? 'and').toLowerCase() === 'or' ? mergeOr(states) : mergeAnd(states)
}

function unionFixed (...sets: Array<Set<string>>): Set<string> {
  return new Set(sets.flatMap(set => [...set]))
}

function directFieldStatement (statement: Record<string, unknown>): string | undefined {
  if (
    typeof statement.field !== 'string' ||
    statement.aggregate !== undefined ||
    statement.formula !== undefined ||
    statement.function !== undefined ||
    statement.constant !== undefined
  ) return undefined
  return statement.field
}

function selectedOutputFields (query: Record<string, unknown>, from: TableDefinition): Map<string, string | undefined> {
  const outputs = new Map<string, string | undefined>()
  if (!Array.isArray(query.select)) return outputs
  for (const value of query.select) {
    if (!isRecord(value)) continue
    const output = resolvedSelectOutputName(value)
    const direct = directFieldStatement(value)
    const resolved = direct === undefined ? undefined : resolveKnownField(from, direct)
    if (output !== undefined) outputs.set(output, resolved === undefined ? undefined : fieldKey(resolved))
  }
  return outputs
}

function preservedDimensions (query: Record<string, unknown>, from: TableDefinition): Set<string> {
  const selected = new Set<string>()
  const directOutputs = new Map<string, string>()
  if (Array.isArray(query.select)) {
    for (const value of query.select) {
      if (!isRecord(value)) continue
      const reference = directFieldStatement(value)
      const resolved = reference === undefined ? undefined : resolveKnownField(from, reference)
      const field = resolved === undefined ? undefined : fieldKey(resolved)
      const output = resolvedSelectOutputName(value)
      if (field !== undefined) selected.add(field)
      if (field !== undefined && output !== undefined) directOutputs.set(output, field)
    }
  }

  const grouped = new Set<string>()
  if (Array.isArray(query.group)) {
    for (const value of query.group) {
      if (typeof value !== 'string') continue
      const directOutput = directOutputs.get(value)
      const resolved = directOutput === undefined ? resolveKnownField(from, value) : undefined
      const field = directOutput ?? (resolved === undefined ? undefined : fieldKey(resolved))
      if (field !== undefined) grouped.add(field)
    }
  }
  return expandJoinEquivalentFields(from, new Set([...grouped].filter(field => selected.has(field))))
}

function missingRequiredDimensions (
  resolved: ResolvedField,
  available: Set<string>
): { missing: string[], options: string[][] } {
  const { table, column } = resolved
  const required = column.aggregation.required_dimensions
  if (required === undefined) return { missing: [], options: [] }
  const has = (field: string): boolean => available.has(`${table.name}.${field}`)
  const missing = (required.all_of ?? []).filter(field => !has(field))
  const alternatives = required.one_of ?? []
  if (alternatives.length > 0 && !alternatives.some(option => option.every(has))) {
    const closest = alternatives
      .map((option, index) => ({ index, missing: option.filter(field => !has(field)) }))
      .sort((left, right) => left.missing.length === right.missing.length
        ? left.index - right.index
        : left.missing.length - right.missing.length)[0]
    return { missing: [...new Set([...missing, ...closest.missing])], options: alternatives }
  }
  return { missing, options: [] }
}

function presentedDimension (table: TableDefinition, field: string): string {
  const frontendName = findColumn(table, field)?.frontend_name
  return frontendName === undefined ? field : `${frontendName} (backend field ${field})`
}

function safeReformulations (table: TableDefinition, column: ColumnDefinition, missing: string[], options: string[][]): string[] {
  const reformulations: string[] = []
  if (missing.length > 0) {
    reformulations.push(`Select and group by ${missing.map(field => presentedDimension(table, field)).join(', ')}, or constrain each backend field to one exact value.`)
  }
  if (options.length > 0) {
    reformulations.push(`Select and group by, or exactly filter, every backend field in one supported key: ${options.map(option => option.map(field => presentedDimension(table, field)).join(' + ')).join(' OR ')}.`)
  }
  if (column.aggregation.allowed_aggregates.length > 0) {
    reformulations.push(`Use only the declared aggregate${column.aggregation.allowed_aggregates.length === 1 ? '' : 's'}: ${column.aggregation.allowed_aggregates.join(', ')}.`)
  } else {
    reformulations.push('Select the value at its documented row grain without aggregating it.')
  }
  reformulations.push(column.aggregation.guidance)
  return reformulations
}

function windowReferences (from: TableDefinition, statement: Record<string, unknown>): ResolvedField[] {
  const references: ResolvedField[] = []
  const visit = (select: Record<string, unknown>): void => {
    if (typeof select.field === 'string') {
      const resolved = resolveKnownField(from, select.field)
      if (resolved?.column.aggregation.kind === 'window_total') references.push(resolved)
    }
    if (isRecord(select.formula) && Array.isArray(select.formula.terms)) {
      select.formula.terms.forEach(term => {
        if (isRecord(term)) visit(term)
      })
    }
    const functionExpression = select.function
    if (isRecord(functionExpression) && Array.isArray(functionExpression.args)) {
      functionExpression.args.forEach((argument, index) => {
        if (functionExpression.name === 'if' && index === 0) return
        if (isRecord(argument)) visit(argument)
      })
    }
  }
  visit(statement)
  return references
}

function semanticViolations (query: Record<string, unknown>, from: TableDefinition): SemanticViolation[] {
  const violations: SemanticViolation[] = []
  const preserved = preservedDimensions(query, from)
  const outputFields = selectedOutputFields(query, from)
  const globallyFixed = expandJoinEquivalentFields(from, new Set(conditionConstraints(query.where, from, outputFields).fixed.keys()))
  const baseAvailable = unionFixed(preserved, globallyFixed)

  const addAggregateViolation = (
    resolved: ResolvedField,
    aggregate: DataAggregate,
    path: string,
    available: Set<string>
  ): void => {
    const { table, column } = resolved
    const allowed = column.aggregation.allowed_aggregates.includes(aggregate)
    const required = missingRequiredDimensions(resolved, available)
    if (allowed && required.missing.length === 0 && required.options.length === 0) return

    const reasons: string[] = []
    if (!allowed) {
      reasons.push(column.aggregation.allowed_aggregates.length === 0
        ? `${column.name} is a row-level value and cannot be aggregated.`
        : `${aggregate} is not compatible with the declared ${column.aggregation.kind} contract.`)
    }
    if (required.missing.length > 0 || required.options.length > 0) {
      reasons.push('The query drops dimensions needed to keep the represented entities disjoint or the repeated value well-defined.')
    }
    violations.push({
      path,
      table: table.name,
      field: column.name,
      aggregate,
      aggregation_kind: column.aggregation.kind,
      unit: column.aggregation.unit,
      allowed_aggregates: [...column.aggregation.allowed_aggregates],
      missing_dimensions: required.missing,
      ...(required.options.length === 0 ? {} : { required_dimension_options: required.options }),
      reason: reasons.join(' '),
      why_misleading: column.aggregation.guidance,
      safe_reformulations: safeReformulations(table, column, required.missing, required.options),
      relevant_recipes: recipeNamesForTable(table.name)
    })
  }

  const analyze = (
    statement: Record<string, unknown>,
    path: string,
    inheritedAggregate?: DataAggregate,
    inheritedFixed: Set<string> = baseAvailable
  ): void => {
    const aggregate = typeof statement.aggregate === 'string' ? statement.aggregate as DataAggregate : inheritedAggregate
    const conditionalFixed = statement.condition === undefined
      ? new Set<string>()
      : new Set(conditionConstraints(statement.condition, from, outputFields).fixed.keys())
    const available = expandJoinEquivalentFields(from, unionFixed(inheritedFixed, conditionalFixed))

    if (typeof statement.field === 'string' && aggregate !== undefined) {
      const resolved = resolveKnownField(from, statement.field)
      if (resolved !== undefined) addAggregateViolation(resolved, aggregate, `${path}.field`, available)
    }

    // topKWeighted accumulates its weight column even though the outer
    // aggregate returns the associated value. Treat the weight as a sum so a
    // repeated or overlapping measure cannot bypass its contract by moving
    // from `field` into `weight`.
    if (typeof statement.weight === 'string' && aggregate === 'topKWeighted') {
      const resolved = resolveKnownField(from, statement.weight)
      if (resolved !== undefined) addAggregateViolation(resolved, 'sum', `${path}.weight`, available)
    }

    if (isRecord(statement.formula)) {
      if (statement.formula.operator === '+') {
        const byGroup = new Map<string, ResolvedField[]>()
        for (const reference of windowReferences(from, statement)) {
          const group = reference.column.aggregation.incompatible_addition_group
          if (group === undefined) continue
          byGroup.set(group, [...(byGroup.get(group) ?? []), reference])
        }
        for (const fields of byGroup.values()) {
          if (fields.length < 2) continue
          const first = fields[0]
          violations.push({
            path: `${path}.formula`,
            table: first.table.name,
            field: fields.map(reference => reference.column.name).join(' + '),
            aggregation_kind: 'window_total',
            unit: first.column.aggregation.unit,
            allowed_aggregates: [...first.column.aggregation.allowed_aggregates],
            missing_dimensions: [],
            reason: 'The formula adds precomputed reporting windows that overlap in time, so the same earnings would be counted more than once.',
            why_misleading: 'Overlapping precomputed windows contain some of the same earnings, so their sum double counts those dates.',
            safe_reformulations: ['Select the windows as separate outputs, or use a non-overlapping source table for a custom period.'],
            relevant_recipes: recipeNamesForTable(first.table.name)
          })
        }
      }
      if (Array.isArray(statement.formula.terms)) {
        statement.formula.terms.forEach((term, index) => {
          if (isRecord(term)) analyze(term, `${path}.formula.terms[${index}]`, aggregate, available)
        })
      }
    }

    const functionExpression = statement.function
    if (isRecord(functionExpression) && Array.isArray(functionExpression.args)) {
      functionExpression.args.forEach((argument, index) => {
        if (functionExpression.name === 'if' && index === 0) return
        if (isRecord(argument)) analyze(argument, `${path}.function.args[${index}]`, aggregate, available)
      })
    }
  }

  if (Array.isArray(query.select)) {
    query.select.forEach((statement, index) => {
      if (isRecord(statement)) analyze(statement, `select[${index}]`)
    })
  }
  return violations
}

export function validateDataQuerySemantics (query: Record<string, unknown>): void {
  const references = referenceViolations(query)
  if (references.violations.length > 0) {
    throw new CliError('UNKNOWN_DATA_REFERENCE', 'The query references a table or field outside this CLI\'s bundled analytics contract.', 2, {
      details: { violations: references.violations },
      hint: 'Use `poki data tables`, `poki data table TABLE`, and `poki data column TABLE COLUMN` to choose only bundled sources and fields.'
    })
  }
  if (references.from === undefined) return

  const violations = semanticViolations(query, references.from)
  if (violations.length > 0) {
    throw new CliError('INCOMPATIBLE_GRAIN', 'The query contains aggregations that are incompatible with the bundled field grain.', 2, {
      details: { violations },
      hint: 'Preserve or exactly filter every required dimension. If a contract says the unique rollup is unavailable, use a source at the entity grain instead of summing these rows.'
    })
  }
}
