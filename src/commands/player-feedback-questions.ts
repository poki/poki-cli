import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { playerFeedbackQuestionsDocumentation } from '../docs/resources'
import { CliError, inputError } from '../errors'
import { characterCount, containsZeroWidthCharacter } from '../input'
import { jsonApiDocument } from '../jsonapi'
import { isRecord } from '../json'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { AsyncCreateContract, createThenWait, pollArguments } from './async-create'
import { registerResourceDiscovery } from './resource-docs'
import {
  asStrings,
  gamePath,
  getResource,
  listResources,
  mutationInputFields,
  mutationPreview,
  normalizeMutationResponse,
  pollUntil,
  PollOutcome,
  render,
  renderList,
  renderMutation,
  requestTimeout,
  requireConfirmation,
  resolveMutationInput,
  withDataOption,
  withDefaultGameOption,
  withGameActionOptions,
  withGameMutationOptions,
  withListOptions,
  withOutputOptions,
  withWaitMeta,
  withWaitOptions
} from './common'

const messageTypes = ['thumbs_up', 'thumbs_down', 'bugreport'] as const
const createInput = mutationInputFields({
  question: 'question',
  startDate: 'start_date',
  endDate: 'end_date',
  messageType: 'feedback_message_types'
})

function questionPath (game: unknown, question?: unknown): string {
  return gamePath(game, 'player_feedback_questions', ...(question === undefined ? [] : [question]))
}

// Generation status values documented on the resource; completed and failed
// are terminal.
function questionStatusOf (resource: unknown): string {
  const data = isRecord(resource) ? resource.data : undefined
  const status = isRecord(data) ? data.status : undefined
  return typeof status === 'string' ? status : 'unknown'
}

async function waitForQuestion (api: ApiClient, game: unknown, questionId: string, argv: Record<string, unknown>): Promise<PollOutcome> {
  return await pollUntil(argv, async timeoutMs => {
    const resource = await getResource(
      api,
      questionPath(game, questionId),
      { ...argv, raw: false, timeoutMs },
      { type: 'player_feedback_questions', id: questionId },
      'player-feedback question poll'
    )
    const status = questionStatusOf(resource)
    return { resource, state: status, terminal: status === 'completed' || status === 'failed', succeeded: status === 'completed' }
  }, `player feedback question ${questionId} generation`, requestTimeout(argv) ?? api.timeoutMs)
}

const createWaitContract: AsyncCreateContract = {
  errorCode: 'PLAYER_FEEDBACK_QUESTION_CREATE_WAIT_FAILED',
  noun: 'question',
  missingId: {
    message: 'The player-feedback question creation succeeded, but its response did not include a usable question ID.',
    hint: 'Do not create the question again. Use details.recovery.inspect_created_question to list existing questions and identify the created resource.'
  },
  pollFailed: {
    message: 'The player-feedback question was created, but polling its generation state failed.',
    hint: 'Do not create the question again. Use details.recovery.resume_poll to continue polling the created question.'
  },
  inspect: argv => ({
    action: 'list_existing_player_feedback_questions',
    arguments: [
      'player-feedback-questions', 'list',
      '--game', String(argv.game),
      '--sort', '-created_at',
      '--fields', 'id,question,status,created_at',
      '--format', 'json'
    ]
  }),
  resumePoll: (createdId, argv) => ({
    action: 'poll_existing_player_feedback_question',
    arguments: [
      'player-feedback-questions', 'get', createdId,
      '--game', String(argv.game),
      '--wait',
      ...pollArguments(argv),
      '--format', 'json'
    ]
  })
}

function unixDate (value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw inputError(`${field} must be a UTC calendar date in YYYY-MM-DD format or an integer Unix timestamp.`)
  }
  const milliseconds = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw inputError(`${field} must be a real UTC calendar date in YYYY-MM-DD format.`)
  }
  return Math.floor(milliseconds / 1000)
}

export function registerPlayerFeedbackQuestionCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('player-feedback-questions', 'List, inspect, create, and delete generated player-feedback questions', questions => registerResourceDiscovery(questions, playerFeedbackQuestionsDocumentation)
    .command('list', 'List generated feedback questions for one game', list => withDefaultGameOption(withListOptions(list, listCapabilities.playerFeedbackQuestions, 'player-feedback-questions'), projectGameId, 'Game whose questions to list'), async argv => {
      renderList(await listResources(api, questionPath(argv.game), argv, listCapabilities.playerFeedbackQuestions), argv, 'player-feedback-questions')
    })
    .command('get <question-id>', 'Get one generated feedback question and response', get => withWaitOptions(withDefaultGameOption(withOutputOptions(get), projectGameId, 'Game that owns the question'), 'Poll until status reaches completed; failed exits nonzero with the final resource')
      .positional('question-id', { describe: 'Player feedback question ID', type: 'string', demandOption: true }), async argv => {
      if (argv.wait === true) {
        const outcome = await waitForQuestion(api, argv.game, String(argv.questionId), argv)
        render(withWaitMeta(outcome), argv)
        return
      }
      const questionID = String(argv.questionId)
      render(await getResource(api, questionPath(argv.game, questionID), argv, { type: 'player_feedback_questions', id: questionID }, 'player-feedback question read'), argv)
    })
    .command('create', 'Queue a question over a bounded player-feedback date range', create => withWaitOptions(withGameMutationOptions(withDataOption(create, 'JSON or TOON object containing question, start_date, end_date, and feedback_message_types'), projectGameId, 'Game whose feedback to analyze'), 'After creation, poll until status reaches completed; failed exits nonzero with the final resource')
      .option('question', { describe: 'Required natural-language question, up to 10000 characters', type: 'string' })
      .option('start-date', { describe: 'Required inclusive UTC date in YYYY-MM-DD format; sent as Unix seconds', type: 'string' })
      .option('end-date', { describe: 'Required inclusive UTC date in YYYY-MM-DD format; sent as Unix seconds and must not precede start-date', type: 'string' })
      .option('message-type', { describe: 'Feedback type; repeat one or more times', choices: messageTypes, type: 'array' }), async argv => {
      const data = await resolveMutationInput(argv, createInput, () => ({
        question: argv.question,
        start_date: argv.startDate,
        end_date: argv.endDate,
        feedback_message_types: asStrings(argv.messageType)
      }))
      if (typeof data.question !== 'string' || data.question.trim() === '' || characterCount(data.question) > 10000) throw inputError('question must contain 1 through 10000 characters.')
      if (containsZeroWidthCharacter(data.question)) throw inputError('question must not contain zero-width characters.')
      const startDate = unixDate(data.start_date, 'start_date')
      const endDate = unixDate(data.end_date, 'end_date')
      if (endDate < startDate) throw inputError('end_date must be on or after start_date.')
      data.start_date = startDate
      data.end_date = endDate
      if (!Array.isArray(data.feedback_message_types) || data.feedback_message_types.length === 0 || data.feedback_message_types.some(type => !messageTypes.includes(type as typeof messageTypes[number]))) {
        throw inputError(`feedback_message_types must contain one or more of: ${messageTypes.join(', ')}.`)
      }
      const path = questionPath(argv.game)
      const body = jsonApiDocument('player_feedback_questions', data)
      if (mutationPreview('POST', path, body, argv, { sideEffects: ['Queues asynchronous feedback analysis and model generation.'] })) return
      await createThenWait({
        contract: createWaitContract,
        argv,
        send: async () => await api.request({ method: 'POST', path, body, timeoutMs: requestTimeout(argv) }),
        normalize: (response, onRecoverySnapshot) => normalizeMutationResponse(response.body, response.status, 'POST', path, { type: 'player_feedback_questions' }, onRecoverySnapshot),
        createdIdOf: (normalized, response) => {
          const created = normalized.data
          if (isRecord(created) && typeof created.id === 'string') return created.id
          throw new CliError('INVALID_API_RESPONSE', 'The successful create response did not include a question ID.', 5, {
            status: response.status,
            retryable: false,
            hint: 'The mutation may already have committed. Inspect current question state and do not replay the create blindly.'
          })
        },
        requireCreatedId: 'when_waiting',
        recoveryFromSnapshot: data => isRecord(data) && data.type === 'player_feedback_questions' ? data : undefined,
        recoveryFromNormalized: data => isRecord(data) ? data : undefined,
        poll: async createdId => await waitForQuestion(api, argv.game, createdId, argv)
      })
    })
    .command('delete <question-id>', 'Delete a generated feedback question', remove => withGameActionOptions(remove, projectGameId, 'Game that owns the question', { destructive: true })
      .positional('question-id', { describe: 'Player feedback question ID', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Deleting a player feedback question')
      const id = String(argv.questionId)
      await renderMutation(api, argv, { method: 'DELETE', path: questionPath(argv.game, id), expected: { type: 'player_feedback_questions', id }, behavior: { destructive: true, sideEffects: ['Deletes the generated question and response resource.'] }, action: { result: { id, deleted: true } } })
    })
    .demandCommand(1, 'Choose player-feedback-questions list, get, create, or delete.'), () => {})
}
