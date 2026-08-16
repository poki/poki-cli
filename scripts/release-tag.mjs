const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SAFE_DIST_TAG = /^[a-z][a-z0-9._-]*$/

function prereleaseVersion (version) {
  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`Package version '${version}' is not valid semantic version syntax.`)
  const identifiers = match[4]?.split('.') ?? []
  if (identifiers.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
    throw new Error(`Package version '${version}' is not valid semantic version syntax.`)
  }
  return identifiers.length > 0
}

function explicitPublishTags (arguments_) {
  const tags = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '-t' || argument.startsWith('-t=')) {
      throw new Error('Use the explicit --tag option for release publication.')
    }
    if (argument === '--tag') {
      const value = arguments_[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--tag requires one dist-tag value.')
      tags.push(value)
      index += 1
      continue
    }
    if (argument.startsWith('--tag=')) tags.push(argument.slice('--tag='.length))
  }
  return tags
}

export function validatePublishTag (version, publishArguments) {
  const prerelease = prereleaseVersion(version)
  const tags = explicitPublishTags(publishArguments)
  if (tags.length > 1) throw new Error('Release publication accepts exactly one --tag option.')

  const tag = tags[0]
  if (tag !== undefined && !SAFE_DIST_TAG.test(tag)) {
    throw new Error(`Invalid npm dist-tag '${tag}'; use a lowercase tag beginning with a letter and containing only letters, digits, dot, underscore, or hyphen.`)
  }
  if (prerelease && tag === undefined) {
    throw new Error('A prerelease package version requires one explicit non-latest --tag.')
  }
  if (prerelease && tag === 'latest') {
    throw new Error('A prerelease package version cannot be published with the latest dist-tag.')
  }

  return tag
}

export function resolveReleasePublishArguments (version, publishArguments) {
  const tag = validatePublishTag(version, publishArguments)

  // npm otherwise inherits `tag` from user, project, or environment config.
  // Own the stable default on the command line so those ambient settings cannot
  // silently publish a stable release under a non-latest dist-tag.
  return tag === undefined
    ? [...publishArguments, '--tag', 'latest']
    : [...publishArguments]
}
