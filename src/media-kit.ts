import { isRecord } from './json'

const sourceBytes = 100 * 1024 * 1024

export const mediaKitTypes = [
  {
    type: 'video_gameplay',
    label: 'Gameplay clips',
    extensions: ['.mp4', '.mov'],
    max_bytes: 1024 * 1024 * 1024,
    requirements: ['H.264', '30–90 seconds', '1920x1080, 1080x1920, or 1080x1080'],
    guidance: ['Recommend 3 clean raw gameplay clips without hardcoded text, UI overlays, score counters, or watermarks.']
  },
  {
    type: 'image_screenshot',
    label: 'In-game screenshots',
    extensions: ['.png', '.jpg', '.jpeg'],
    max_bytes: sourceBytes,
    requirements: ['Landscape minimum 1920x1080 or portrait minimum 1080x1920; square screenshots are not accepted.', 'At most 10 screenshots, including legacy orientation-specific image types.'],
    guidance: ['Recommend 5–10 real gameplay moments, not menus or loading screens.']
  },
  {
    type: 'image_logo_icon',
    label: 'Icon-only logo',
    extensions: ['.png'],
    max_bytes: sourceBytes,
    requirements: ['Minimum 1024x1024', 'At most one icon logo; delete the existing asset before replacement.'],
    guidance: ['Use a transparent background, flat centred artwork, and breathing room; avoid baked-in shadows and glows.']
  },
  {
    type: 'image_logo_lockup',
    label: 'Full logo lockup',
    extensions: ['.png'],
    max_bytes: sourceBytes,
    requirements: ['Minimum 1024x1024', 'At most one full lockup logo; delete the existing asset before replacement.'],
    guidance: ['Include the game name on transparency; keep artwork flat and centred without background plates.']
  },
  {
    type: 'image_character',
    label: 'Characters',
    extensions: ['.png'],
    max_bytes: sourceBytes,
    requirements: ['Longest side at least 2000px'],
    guidance: ['One character per transparent PNG, exported from source files; no sprite sheets or animation strips.']
  },
  {
    type: 'image_background',
    label: 'Backgrounds',
    extensions: ['.png', '.jpg', '.jpeg'],
    max_bytes: sourceBytes,
    requirements: ['Minimum 1920x1080 or 1080x1920'],
    guidance: ['Clean backgrounds without characters or UI; keep the middle visually calm.']
  },
  {
    type: 'extra_asset',
    label: 'Extra assets',
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.psd', '.ai', '.otf', '.ttf'],
    max_bytes: sourceBytes,
    requirements: ['No image dimensions or video metadata requirements.'],
    guidance: ['Share key art, icons, sprites, palettes, fonts, or other source artwork.']
  }
] as const

export const mediaKitUploadTypes = mediaKitTypes.map(spec => spec.type)
export const mediaKitAssetTypes = [
  ...mediaKitUploadTypes,
  'video_vertical', 'video_landscape', 'video_square',
  'image_landscape_1', 'image_landscape_2', 'image_square', 'image_portrait', 'image_vertical'
]
export const maxMediaKitUploadFiles = 50

export interface MediaKitUploadFailure { filename: string, error: string }

// This endpoint also returns failures in a JSON:API data document with HTTP 400.
// Only these two reviewed fields may escape the transport's error boundary.
export function mediaKitUploadFailures (body: unknown): MediaKitUploadFailure[] | undefined {
  if (!isRecord(body) || !isRecord(body.meta) || !Array.isArray(body.meta.failed)) return undefined
  if (body.meta.failed.some(item => !isRecord(item) || typeof item.filename !== 'string' || typeof item.error !== 'string')) return undefined
  return body.meta.failed.map(item => ({ filename: item.filename as string, error: item.error as string }))
}
