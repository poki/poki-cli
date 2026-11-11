import { spawnSync } from 'node:child_process'

const RELEASE_REMOTE = 'origin'

function runGit (projectDirectory, arguments_, acceptedStatuses = [0]) {
  const result = spawnSync('git', arguments_, {
    cwd: projectDirectory,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.error !== undefined) {
    throw new Error('git could not be started.', { cause: result.error })
  }
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error([
      `git ${arguments_.join(' ')} failed${result.status === null ? '' : ` with exit code ${String(result.status)}`}.`,
      result.stdout?.trim(),
      result.stderr?.trim()
    ].filter(Boolean).join('\n'))
  }
  return result
}

function localTagTarget (projectDirectory, reference) {
  const result = runGit(projectDirectory, ['rev-parse', '--verify', '--quiet', reference], [0, 1])
  return result.status === 0 ? result.stdout.trim() : undefined
}

function remoteTagTarget (projectDirectory, remote, reference) {
  const result = runGit(projectDirectory, ['ls-remote', '--exit-code', '--refs', remote, reference], [0, 2])
  if (result.status === 2) return undefined
  const [target, returnedReference, extra] = result.stdout.trim().split(/\s+/)
  if (target === undefined || returnedReference !== reference || extra !== undefined) {
    throw new Error(`git returned an invalid response while inspecting '${reference}' on '${remote}'.`)
  }
  return target
}

export function prepareReleaseGitTag (projectDirectory, version) {
  const tag = `v${version}`
  const reference = `refs/tags/${tag}`
  runGit(projectDirectory, ['check-ref-format', reference])

  const staged = runGit(projectDirectory, ['diff', '--cached', '--name-only', '--no-ext-diff', 'HEAD', '--']).stdout.trim()
  if (staged !== '') {
    throw new Error('Release publication requires every indexed change to be committed so the Git tag identifies the exact npm package bytes.')
  }

  const commit = runGit(projectDirectory, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim()
  if (localTagTarget(projectDirectory, reference) !== undefined) {
    throw new Error(`Git tag '${tag}' already exists locally; refusing to publish an npm version whose Git tag is ambiguous.`)
  }
  if (remoteTagTarget(projectDirectory, RELEASE_REMOTE, reference) !== undefined) {
    throw new Error(`Git tag '${tag}' already exists on '${RELEASE_REMOTE}'; refusing to publish an npm version whose Git tag is ambiguous.`)
  }

  // Exercise remote selection, authentication, and the ref update before npm's
  // irreversible publication. The real push still happens only after npm wins.
  runGit(projectDirectory, ['push', '--dry-run', '--porcelain', RELEASE_REMOTE, `${commit}:${reference}`])

  return Object.freeze({ projectDirectory, remote: RELEASE_REMOTE, tag, reference, commit })
}

function incompleteTagError (plan, cause) {
  let remoteTarget
  let localTarget
  let remoteInspected = false
  let localInspected = false
  try {
    remoteTarget = remoteTagTarget(plan.projectDirectory, plan.remote, plan.reference)
    remoteInspected = true
  } catch {}
  try {
    localTarget = localTagTarget(plan.projectDirectory, plan.reference)
    localInspected = true
  } catch {}

  if (remoteInspected && remoteTarget === plan.commit) return undefined

  const recovery = remoteInspected && remoteTarget === undefined && localInspected && localTarget === plan.commit
    ? `Run: git push ${plan.remote} ${plan.reference}:${plan.reference}`
    : remoteInspected && remoteTarget === undefined && localInspected && localTarget === undefined
      ? `After confirming HEAD is still ${plan.commit}, run: git tag ${plan.tag} ${plan.commit} && git push ${plan.remote} ${plan.reference}:${plan.reference}`
      : `First inspect '${plan.reference}' locally and on '${plan.remote}'; it must point to ${plan.commit}. Push or create it only after confirming the remote tag is absent, and do not force an existing tag.`

  return new Error([
    `npm publication succeeded, but Git tag '${plan.tag}' was not confirmed on '${plan.remote}'.`,
    'Do not rerun yarn release:publish; npm package versions are immutable.',
    recovery
  ].join('\n'), { cause })
}

export function publishReleaseGitTag (plan) {
  try {
    runGit(plan.projectDirectory, ['update-ref', plan.reference, plan.commit, ''])
    runGit(plan.projectDirectory, ['push', '--porcelain', plan.remote, `${plan.reference}:${plan.reference}`])
  } catch (cause) {
    const error = incompleteTagError(plan, cause)
    if (error !== undefined) throw error
  }
}
