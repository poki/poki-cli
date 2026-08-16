# poki-cli

[![npm](https://img.shields.io/npm/v/@poki/cli.svg?style=flat-square)](https://www.npmjs.com/package/@poki/cli)
[![node](https://img.shields.io/node/v/@poki/cli.svg?style=flat-square)](https://nodejs.org/)
[![license](https://img.shields.io/github/license/poki/poki-cli.svg?style=flat-square)](LICENSE)

The [Poki for Developers](https://developers.poki.com/) CLI is designed primarily for LLMs. Humans only need to install it, configure the current game project, and complete browser authentication. The CLI itself contains the structured command documentation, field references, examples, permissions, and safety information an LLM needs.

## Install

Node.js 20.7 or newer is required. Choose one persistent [npm installation mode](https://docs.npmjs.com/cli/install/).

Install globally when the CLI should be available to the current user in every project:

```sh
npm install --global --ignore-scripts @poki/cli
poki --version
```

Invoke this installation as `poki`.

Install as a project-local development dependency when the project should pin and share its CLI version:

```sh
npm install --save-dev --ignore-scripts @poki/cli
npx @poki/cli --version
```

Invoke this installation as `npx @poki/cli`. Installing or updating this mode modifies the project's `package.json` and npm lockfile, so review and commit those changes with the project.

## Configure the project

From the game project directory, run:

```sh
npx @poki/cli init --game GAME_ID --build-dir dist
```

`GAME_ID` is the game ID shown on its Poki for Developers page. `build-dir` is the directory containing the built game. This creates `poki.json`:

```json
{
  "game_id": "GAME_ID",
  "build_dir": "dist"
}
```

Use `--force` if an existing `poki.json` should be replaced.

The same configuration can instead be stored in `package.json`:

```json
{
  "poki": {
    "game_id": "GAME_ID",
    "build_dir": "dist"
  }
}
```

When both exist, `poki.json` takes precedence. Run the CLI from the configured project directory.

## Log in

Authenticate explicitly once:

```sh
npx @poki/cli auth login
```

This opens the Poki sign-in flow in a browser and saves OAuth credentials locally. Normal API and analytics commands never open a browser automatically. The only exception is the deprecated legacy `upload` command, which preserves its pre-existing implicit browser-login behavior for backwards compatibility.

## Upgrading from 0.1.x

`init` and the deprecated top-level `upload` command keep working as before, with one deliberate change: `poki upload` now exits non-zero when the archive or the upload fails. In 0.1.x it logged the failure and still exited `0`, so a pipeline could not tell a published build from a lost one. The human output is unchanged; a structured error document is appended to stderr after it.

Automated pipelines should move to `poki versions upload`, which reports structured results on stdout and supports `--wait`, `--dry-run`, and `--format json`.

## Compatibility policy

Cross-release backwards compatibility is guaranteed only for `init`, the `auth login`, `auth status`, and `auth logout` commands, and the deprecated top-level `upload` command. That guarantee covers their documented command names, accepted inputs, core behavior, and documented output, while allowing explicitly documented safety or correctness fixes such as the legacy upload exit-code change above.

No other command, option, normalized response shape, or workflow has a future cross-release backwards-compatibility guarantee or deprecation period. Automation using the modern LLM-focused surface should pin an exact `@poki/cli@VERSION`, review `poki help --all` after an intentional upgrade, and update its assumptions before adopting the new version.

## Use with an LLM

After setup, the LLM should start by running:

```sh
npx @poki/cli
```

The resulting structured help explains how to discover and use every supported command. This README intentionally does not duplicate that LLM-facing documentation.

### Example prompts

Copy one of these tasks into an LLM agent while it is running in a configured game project.

#### Analyze game health

```text
Use the Poki CLI to analyze the configured game's events, errors, and player feedback from the last 30 days. Keep it read-only and report the most important findings with supporting numbers.
```

#### Run a playtest

```text
Use the Poki CLI to request 10 playtest recordings for the newest eligible version. Analyze every recording in parallel, summarize the main issues, and do not create a duplicate request.
```

#### Compare version activations

```text
Use the Poki CLI to compare gameplay and revenue before and after recent version activations. Keep it read-only and clearly explain any limits in the data.
```

### Daily update guidance

Before the first eligible Poki API request in a rolling 24-hour period, the CLI asks npm for the stable `latest` version. The completed command continues normally. If a newer stable version exists, its successful result stays on stdout and a separate structured `CLI_UPDATE_AVAILABLE` notice is written to stderr after completion.

The notice gives the LLM two exact, version-pinned choices:

```sh
npm install --global --ignore-scripts --no-audit --no-fund @poki/cli@AVAILABLE_VERSION
npm install --save-dev --ignore-scripts --no-audit --no-fund @poki/cli@AVAILABLE_VERSION
```

The LLM should choose the command matching the installation mode, verify it with `poki --version` or `npx @poki/cli --version`, and must not replay the command that already completed. The advisory never self-updates the CLI, never blocks the completed command, and follows only npm's stable `latest` tag. Help, version, auth, offline commands, ordinary dry-runs, analytics validation, and the deprecated legacy upload path do not perform the update lookup. Set `POKI_CLI_UPDATE_CHECK=0` to opt out. Run `poki help updates` for the complete machine-readable contract.

## Release

Publish only through the repository release command:

```sh
yarn release:publish
```

It validates the source and dependency audit, builds a tarball from the active Git index with lifecycle scripts explicitly enabled, verifies that exact tarball through a real install, and publishes the verified archive. npm publish options may be appended, for example `yarn release:publish --dry-run`. Do not use bare `npm publish`: user or global npm configuration can disable lifecycle scripts and omit the generated CLI executable.

To publish an experiment without moving the stable `latest` [npm dist-tag](https://docs.npmjs.com/cli/dist-tag/):

1. Set and stage a unique prerelease version such as `0.2.0-experimental.0`.
2. Run `yarn release:publish -- --tag experimental`.
3. Verify both channels independently with `npm view @poki/cli dist-tags --json`.
4. Opt-in developers install it globally with `npm install --global --ignore-scripts @poki/cli@experimental` or locally with `npm install --save-dev --ignore-scripts @poki/cli@experimental`.
5. Give every subsequent experiment a unique version such as `0.2.0-experimental.1` and publish it with the same explicit tag.
6. Later set the final `0.2.0` version and run `yarn release:publish` normally to move `latest`.

The release command rejects a prerelease version unless it has exactly one explicit, valid, non-`latest` `--tag`. These npm commands change registry versions and dist-tags only; they do not create a Git tag.

## License

The CLI itself is [ISC licensed](LICENSE). The published `bin/index.js` is a bundle that also contains MIT-licensed third-party code; the packages it covers and their required copyright and permission notices are listed at the top of that file.
