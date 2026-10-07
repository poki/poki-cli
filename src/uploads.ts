import { openAsBlob } from 'node:fs'

/**
 * Append a local file without copying its contents into the JavaScript heap.
 * Node's file-backed Blob reports its size to FormData while reading the file
 * lazily as fetch consumes the multipart request body.
 */
export async function appendUploadFile (
  form: FormData,
  field: string,
  path: string,
  filename: string,
  type?: string
): Promise<void> {
  const file = await openAsBlob(path, type === undefined ? undefined : { type })
  form.append(field, file, filename)
}
