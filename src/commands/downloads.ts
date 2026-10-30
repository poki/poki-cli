import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import { link, mkdir, open, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'

import { CliError, inputError, registerInterruptCleanup } from '../errors'

async function downloadFileOperation<T> (destination: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CliError) throw error
    throw inputError(`Could not write '${destination}': ${error instanceof Error ? error.message : String(error)}`, {
      output: destination
    })
  }
}

// These filesystems cannot atomically publish a complete file without replacing
// another writer's destination using the primitives exposed by Node.
const hardLinkUnsupported = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK'])

function destinationExists (destination: string): CliError {
  return inputError(`Destination '${destination}' already exists. Pass --force to replace it.`, { output: destination })
}

// Publishes the completed temporary file without ever replacing an existing
// destination, including one that appears concurrently.
async function publishWithoutReplacing (
  temporary: string,
  destination: string,
  createLink: typeof link
): Promise<void> {
  // The same-directory hard link is the portable Node primitive that both
  // publishes the complete file and fails atomically when the destination
  // already exists. An existsSync()+rename() pair has a TOCTOU window and
  // rename replaces a concurrently created destination on POSIX.
  try {
    await createLink(temporary, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') throw destinationExists(destination)
    if (code === undefined || !hardLinkUnsupported.has(code)) throw error
    throw inputError(`Cannot safely publish '${destination}' without replacing files on this filesystem. Choose a filesystem supporting hard links, or pass --force to allow replacement.`, { output: destination })
  }
}

// Stream into a unique file beside the destination, then rename only after the
// complete response body has been written. This keeps an existing --force
// destination intact on timeout or network failure and makes replacement
// atomic on the destination filesystem. Only filesystem failures are mapped to
// INVALID_INPUT; response-body failures must reach ApiClient so they retain the
// generic signed-download timeout/network contract.
export async function writeDownload (
  destination: string,
  body: ReadableStream<Uint8Array> | null,
  force = false,
  // Injected only so a test can exercise the no-hard-link publication path on a
  // filesystem that does support hard links.
  createLink: typeof link = link
): Promise<number> {
  const directory = dirname(destination)
  const temporary = join(directory, `.poki-download-${process.pid}-${randomUUID()}.tmp`)
  // A signal never runs the finally below, and the temporary name is unique per
  // invocation, so an interrupted retry would otherwise leave one hidden
  // partial file per attempt beside the destination.
  const removeTemporaryOnInterrupt = registerInterruptCleanup(() => { rmSync(temporary, { force: true }) })
  const reader = body?.getReader()
  let file: Awaited<ReturnType<typeof open>> | undefined
  let bodyComplete = body === null
  let bytes = 0

  try {
    await downloadFileOperation(destination, async () => await mkdir(directory, { recursive: true }))
    file = await downloadFileOperation(destination, async () => await open(temporary, 'wx'))

    if (reader !== undefined) {
      while (true) {
        // Deliberately outside downloadFileOperation: a rejected read is a
        // transport failure, not evidence that the destination is invalid.
        const chunk = await reader.read()
        if (chunk.done) {
          bodyComplete = true
          break
        }

        let offset = 0
        while (offset < chunk.value.byteLength) {
          const result = await downloadFileOperation(destination, async () => await file?.write(
            chunk.value,
            offset,
            chunk.value.byteLength - offset
          ))
          const written = result?.bytesWritten ?? 0
          if (written === 0) {
            throw inputError(`Could not write '${destination}': the filesystem wrote zero bytes.`, { output: destination })
          }
          offset += written
          bytes += written
        }
      }
    }

    await downloadFileOperation(destination, async () => await file?.close())
    file = undefined

    await downloadFileOperation(destination, async () => {
      if (force) {
        await rename(temporary, destination)
        return
      }
      await publishWithoutReplacing(temporary, destination, createLink)
    })
    return bytes
  } finally {
    if (!bodyComplete && reader !== undefined) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the original body-read or filesystem failure.
      }
    }
    try {
      reader?.releaseLock()
    } catch {
      // Preserve the original failure.
    }
    if (file !== undefined) {
      try {
        await file.close()
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      await rm(temporary, { force: true })
    } catch {
      // Preserve the original result. A successful no-force publication has a
      // second hard link at destination; removing this temporary name is only
      // cleanup and cannot make the published file partial.
    }
    removeTemporaryOnInterrupt()
  }
}
