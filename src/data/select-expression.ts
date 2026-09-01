import { isRecord } from '../json'

export type SelectExpressionFieldRole = 'value' | 'weight' | 'val' | 'condition_left'

export interface SelectExpressionContext {
  path: string
  counted: boolean
  inCondition: boolean
  aggregate?: string
}

export interface SelectExpressionFieldContext extends SelectExpressionContext {
  role: SelectExpressionFieldRole
}

export interface SelectExpressionVisitor {
  select?: (statement: Record<string, unknown>, context: SelectExpressionContext) => void
  field?: (field: string, context: SelectExpressionFieldContext) => void
  condition?: (expression: unknown[], context: SelectExpressionContext) => void
}

export interface SelectExpressionVisitOptions {
  root?: 'select' | 'condition'
  path?: string
}

export function resolvedSelectOutputName (statement: Record<string, unknown>): string | undefined {
  if (typeof statement.alias === 'string') return statement.alias
  if (typeof statement.field !== 'string') return undefined
  return statement.field.slice(statement.field.lastIndexOf('.') + 1)
}

// Walks the complete select-expression AST, including formula terms, function
// arguments, aggregate conditions, and select expressions used as condition
// operands. The visitor is intentionally structural: validation remains the
// grammar's responsibility, while catalog and safety checks can share one
// traversal without each rebuilding a partial view of the expression tree.
export function visitSelectExpression (
  value: unknown,
  visitor: SelectExpressionVisitor,
  options: SelectExpressionVisitOptions = {}
): void {
  const initialContext: SelectExpressionContext = {
    path: options.path ?? (options.root === 'condition' ? 'condition' : 'select'),
    counted: false,
    inCondition: options.root === 'condition',
    aggregate: undefined
  }

  const visitCondition = (condition: unknown, context: SelectExpressionContext): void => {
    if (Array.isArray(condition)) {
      if (condition.length !== 3) return
      visitor.condition?.(condition, context)

      const left = condition[0]
      if (typeof left === 'string') {
        visitor.field?.(left, { ...context, path: `${context.path}[0]`, role: 'condition_left' })
      } else if (isRecord(left)) {
        visitSelect(left, { ...context, path: `${context.path}[0]` })
      }

      const right = condition[2]
      if (isRecord(right)) visitSelect(right, { ...context, path: `${context.path}[2]` })
      return
    }

    if (!isRecord(condition) || !Array.isArray(condition.expressions)) return
    condition.expressions.forEach((expression, index) => {
      visitCondition(expression, { ...context, path: `${context.path}.expressions[${index}]` })
    })
  }

  const visitSelect = (statement: Record<string, unknown>, context: SelectExpressionContext): void => {
    const aggregate = typeof statement.aggregate === 'string' ? statement.aggregate : context.aggregate
    const counted = context.counted || aggregate === 'count'
    const selectContext = { ...context, aggregate, counted }
    visitor.select?.(statement, selectContext)

    if (typeof statement.field === 'string') {
      visitor.field?.(statement.field, { ...selectContext, path: `${context.path}.field`, role: 'value' })
    }

    if (isRecord(statement.formula) && Array.isArray(statement.formula.terms)) {
      statement.formula.terms.forEach((term, index) => {
        if (isRecord(term)) visitSelect(term, { ...selectContext, path: `${context.path}.formula.terms[${index}]` })
      })
    }

    const functionExpression = statement.function
    if (isRecord(functionExpression) && Array.isArray(functionExpression.args)) {
      functionExpression.args.forEach((argument, index) => {
        const path = `${context.path}.function.args[${index}]`
        if (functionExpression.name === 'if' && index === 0) {
          visitCondition(argument, { ...selectContext, path, inCondition: true })
        } else if (isRecord(argument)) {
          visitSelect(argument, { ...selectContext, path })
        }
      })
    }

    if (typeof statement.weight === 'string') {
      visitor.field?.(statement.weight, { ...selectContext, path: `${context.path}.weight`, role: 'weight' })
    }
    if (typeof statement.val === 'string') {
      visitor.field?.(statement.val, { ...selectContext, path: `${context.path}.val`, role: 'val' })
    }
    if (statement.condition !== undefined) {
      visitCondition(statement.condition, {
        ...selectContext,
        path: `${context.path}.condition`,
        inCondition: true
      })
    }
  }

  if (options.root === 'condition') visitCondition(value, initialContext)
  else if (isRecord(value)) visitSelect(value, initialContext)
}
