/*
 * How a file is shown (docs/FILE_VIEWER_PLAN.md, section 2). Chromium shows what it can itself (a `file:` tab of the browser pane); the rest
 * goes to the viewer page, which turns it into something readable; anything else is a card with the ways to open it elsewhere.
 */

/** The views of the viewer page. */
export type ViewerView = 'docx' | 'sheet' | 'pptx' | 'opendoc' | 'rtf' | 'markdown' | 'notebook' | 'json' | 'code' | 'zip'

export type PreviewInfo =
  /** Chromium shows it: a `file:` tab. */
  | { how: 'native'; label: string }
  /** The viewer page shows it. */
  | { how: 'viewer'; view: ViewerView; label: string }
  /** Nothing in Celeste shows it. `note` says why, for the formats that are known and not supported. */
  | { how: 'card'; label: string; note?: string }

/** The viewer reads a file whole: past this it is not opened. */
export const VIEWER_MAX_BYTES = 200 * 1024 * 1024
/** A text file is shown up to this much, with a note. */
export const TEXT_CUT_BYTES = 1024 * 1024

const ext = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : ''
}

const native = (label: string, list: string): [string[], PreviewInfo] => [list.split(' '), { how: 'native', label }]
const viewer = (view: ViewerView, label: string, list: string): [string[], PreviewInfo] => [list.split(' '), { how: 'viewer', view, label }]
const card = (label: string, list: string, note: string): [string[], PreviewInfo] => [list.split(' '), { how: 'card', label, note }]

const TABLE: [string[], PreviewInfo][] = [
  native('PDF', 'pdf'),
  native('Image', 'png jpg jpeg jpe gif webp avif bmp ico svg'),
  native('Video', 'mp4 m4v webm mov ogv mkv'),
  native('Audio', 'mp3 wav ogg oga opus m4a aac flac'),
  native('Web page', 'html htm xhtml'),
  viewer('docx', 'Word document', 'docx'),
  viewer('sheet', 'Spreadsheet', 'xlsx xlsm xlsb xls ods csv tsv'),
  viewer('pptx', 'Presentation', 'pptx'),
  viewer('opendoc', 'OpenDocument', 'odt odp'),
  viewer('rtf', 'Rich text', 'rtf'),
  viewer('markdown', 'Markdown', 'md markdown mdx'),
  viewer('notebook', 'Notebook', 'ipynb'),
  viewer('json', 'JSON', 'json geojson'),
  viewer('zip', 'Archive', 'zip jar'),
  viewer(
    'code',
    'Text',
    'txt log jsonl ndjson yaml yml toml xml ini cfg conf env properties gitignore editorconfig ' +
      'js mjs cjs jsx ts tsx py pyi java kt kts c h cpp cc cxx hpp cs go rs rb php swift scala sh bash zsh ps1 bat cmd sql css scss less vue svelte lua r pl dart gradle dockerfile makefile tex bib srt vtt diff patch'
  ),
  card('Word document (old format)', 'doc dot', 'The old .doc format cannot be shown here. Open it in Word, or save it as .docx.'),
  card('Presentation (old format)', 'ppt pps', 'The old .ppt format cannot be shown here. Open it in PowerPoint, or save it as .pptx.'),
  card('Image', 'heic heif tif tiff raw cr2 nef psd', 'This kind of image cannot be shown here.'),
  card('Video', 'avi wmv flv mpg mpeg 3gp', 'This kind of video cannot be played here.'),
  card('Archive', '7z rar tar gz tgz bz2 xz', 'This kind of archive cannot be listed here.')
]

const BY_EXT = new Map<string, PreviewInfo>(TABLE.flatMap(([list, info]) => list.map((e) => [e, info] as const)))

/** How a file is shown, by its name. Unknown types are a card. */
export function previewInfo(name: string): PreviewInfo {
  const e = ext(name)
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase()
  // Files with no extension that are text by name (Dockerfile, Makefile), and dotfiles named for what they are (.gitignore, .env).
  if (!e && (base === 'dockerfile' || base === 'makefile' || base === 'license' || base === 'readme')) return { how: 'viewer', view: 'code', label: 'Text' }
  if (!e && /^\.[a-z]+$/.test(base)) return BY_EXT.get(base.slice(1)) ?? { how: 'card', label: 'File' }
  return BY_EXT.get(e) ?? { how: 'card', label: e ? `${e.toUpperCase()} file` : 'File' }
}

/** The extension, lower case, without the dot. */
export const extensionOf = ext

/** The address a file is opened by in a tab of Chromium, for a type Chromium shows. */
export function fileAddress(path: string): string {
  const normal = path.replace(/\\/g, '/')
  // C:/a/b → file:///C:/a/b ; /a/b → file:///a/b ; each part encoded.
  const drive = /^[A-Za-z]:\//.test(normal)
  const encoded = normal
    .split('/')
    .map((part, i) => (drive && i === 0 ? part : encodeURIComponent(part)))
    .join('/')
  return `file://${drive ? '/' : ''}${encoded}`
}

/** What a file's tab is called: its name. */
export function fileTitle(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** The content type the viewer's scheme answers with, by extension. The viewer reads the bytes itself, so this only has to be sensible. */
export function contentTypeFor(name: string): string {
  const types: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', json: 'application/json', md: 'text/markdown', csv: 'text/csv', txt: 'text/plain' }
  return types[ext(name)] ?? 'application/octet-stream'
}
