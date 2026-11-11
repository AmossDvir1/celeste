# Celeste: File Viewer Plan

> **Status, 11 November 2026: built and checked** (section 9 says what, and what is left to try by hand). The owner asked on 11 November 2026 for a display for Office documents, HTML, PDF, images, video, Markdown and other useful file types. Referenced from `IMPLEMENTATION_PLAN.md` (decision 21). The decisions in section 8 are the defaults I picked.

## 1. Summary

Any file the person (or the assistant) points at opens in a **tab of the browser pane**, with the best viewer for its type, without leaving Celeste: a file the assistant made, a file in the project, or one chosen from the disk. What Chromium shows well it shows itself; what needs turning into something readable (Word, Excel, PowerPoint, Markdown, notebooks, tables) is shown by a small **viewer page** that runs in its own sandbox with no connection to Celeste.

## 2. What opens how

| Type | Extensions | Shown by | Notes |
|---|---|---|---|
| **PDF** | pdf | Chromium's own PDF viewer (a `file:` tab) | Search, print, zoom and thumbnails come with it |
| **Images** | png, jpg, jpeg, gif, webp, avif, bmp, ico, svg | Chromium (a `file:` tab) | Not HEIC or TIFF: Chromium cannot show them, so they offer "Open in your program" |
| **Video** | mp4, m4v, webm, mov, ogv, mkv | Chromium's player (a `file:` tab) | Electron ships H.264 and AAC, so common MP4 and MOV play; AVI, WMV and some MKV do not |
| **Audio** | mp3, wav, ogg, oga, opus, m4a, aac, flac | Chromium's player | |
| **HTML** | html, htm | Chromium, as a real page (a `file:` tab) | Scripts run as in a browser, in the pane's profile, with no link to Celeste |
| **Word** | docx | The viewer page, with `docx-preview` (pages, headings, tables, images, lists) | `.doc` (the old binary format) is not supported: a pure-JavaScript reader does not exist that is good enough; it offers "Open in Word" |
| **Excel** | xlsx, xlsm, xls, ods, csv, tsv | The viewer page, with SheetJS (sheets as tabs, a frozen header row, column letters, numbers and dates shown as formatted) | Formulas show their last computed value; charts and pivot tables are not drawn |
| **PowerPoint** | pptx | The viewer page, with `pptx-preview` (slides one at a time, with a strip of thumbnails) | Layout is close, not exact: fonts that are not on the computer, SmartArt, animations and embedded video are not faithful. `.ppt` is not supported |
| **OpenDocument and RTF** | odt, odp, rtf | The viewer page, as a simplified text view (headings, paragraphs, lists, tables) | Not the layout |
| **Markdown** | md, markdown | The viewer page, rendered, with a contents list | |
| **Notebooks** | ipynb | The viewer page: Markdown cells rendered, code cells with their output (text and images) | Read only |
| **Data and code** | json, jsonl, yaml, yml, toml, xml, ini, env, log, txt, and source files (js, ts, py, java, c, cpp, cs, go, rs, rb, php, sh, ps1, sql, css and more) | The viewer page: line numbers, monospace, JSON as a collapsible tree, a search box, wrap on or off | Large files are cut at the first megabyte with a note |
| **Archives** | zip | The viewer page: the list of what is inside, with sizes | Not opened or unpacked |
| **Anything else** | | A card: name, size, type, "Open in your program", "Show in folder" | A program or script is only ever shown in its folder, never started (the rule `canOpenFile` already holds) |

## 3. Where it shows

- Files open as **tabs of the browser pane** (Ctrl+Shift+B): a file tab has a file icon and its name, an address bar that shows the path (not editable), and buttons for "Open in your program" and "Show in folder". Web pages and files sit side by side, as in Claude's browser, which opens HTML, PDF and video paths from the chat in its pane.
- **How a file is opened:** a produced-file card in the chat (Open now previews, and a menu keeps "Open in your program", "Show in folder" and "Save a copy"), a file in Develop's Files panel, and "Open a file…" in the pane's menu (the system's own dialog). A file path in a Markdown link of a message is for later.
- **The assistant's tools do not see viewer tabs.** A viewer tab shows a document that may be private, and the tools' rules (a file only from the chat's own folder) cannot judge it, so viewer tabs are left out of `browser_tabs` and of the DevTools endpoint. A `file:` tab (PDF, image, HTML) is a normal tab and the tools' file rule applies to it.

## 4. How it is built

- **Main process** (`src/main/browser/service.ts`, `src/main/viewer/`): a tab has a `kind`, `'web'` or `'file'`. A file tab is a `WebContentsView` like the others, in the same profile, loading `celeste-view://app/viewer.html?...`. The scheme `celeste-view` is registered like `celeste-file` (privileged, standard, secure, fetch allowed) and answers two things only: the viewer's own files (`/viewer.html`, `/assets/...`, from the built app) and `/__file/<token>/<name>`, the one file that tab was opened with (a random token made when the tab was opened and forgotten when it closes, read-only, at most 200 MB, `Range` supported). No other path on the computer can be reached through it.
- **The viewer page** (`src/renderer/viewer/`, a second page of the renderer build): a React app with no connection to Celeste (no preload, no bridge): it reads the file from its token, picks a view by type, and draws it. A parser that was fooled by a bad file can draw wrong things; it cannot reach Core, other files, or the network (its content policy allows only its own scripts and the one file).
- **The shared helper** `src/shared/preview.ts`: `previewKind(name)` (the table above: `native`, `viewer:docx`, …, `card`), the limits, and the content-type for each extension; used by the window, the main process and the tests.
- **Window:** a file tab in the tab strip, the toolbar for it, "Open a file…", the entry points of section 3, and the produced-file cards. An open file's tab is reused if the same file is opened again.
- **Dependencies** (all run only inside the viewer page): `docx-preview` (Apache-2.0), `pptx-preview` (ISC), `jszip` (MIT or GPL, taken as MIT), and SheetJS Community Edition from its own distribution site (`cdn.sheetjs.com`; the npm copy, 0.18.5, is old and has two published vulnerabilities, fixed from 0.20.2). `react-markdown` and `remark-gfm` are already in the app.

## 5. Security

- A document is untrusted input. It is parsed only in the viewer page, in a view of its own with `sandbox`, no preload, no Node, and the policy `default-src 'none'; script-src 'self'; connect-src celeste-view:; img-src celeste-view: data: blob:; style-src 'self' 'unsafe-inline'`. It cannot call out.
- Scripts inside Office files do not run (no macros: the formats are read as data). HTML in a Markdown file is not rendered as HTML (shown as text).
- A tab can only ask for its own token's file. A web page in another tab cannot read `celeste-view://` files: the scheme is not open to other origins, and the tokens cannot be guessed.
- "Open in your program" uses the existing rule: only document types open in the system's program; a program or script is shown in its folder.
- The window is trusted to name a file (it already can read and run through Core); the dialog's choice comes from the system's own dialog.

## 6. Tests and checks

- **Unit:** `previewKind` for every extension in the table and its neighbours, content types, the limits; the token protocol (a path outside the registered file, `..`, another token, a bad token); Markdown, CSV and JSON helpers; the zip listing.
- **`npm run verify:preview`** in the real app, with files made by the check itself (a docx, an xlsx, a pptx, a csv, a Markdown file, a notebook, a zip, a PNG, an MP4-less video check by element, a PDF): each opens as a tab in the pane, the right view appears with the right text, a produced-file card in a chat opens one, "Open a file…" opens the chosen file, the assistant's tools do not list a viewer tab, and a web page cannot read a file by its address.
- The accessibility audit with a viewer tab open.
- **By hand:** real documents from Word, Excel and PowerPoint (layout fidelity), a long video and seeking in it, a large PDF, a 100 MB file.

## 7. Build order

1. `previewKind` and the plan's limits (shared, tested).
2. The `celeste-view` scheme and file tabs in the main process.
3. The viewer page, one type at a time: text, Markdown, JSON, CSV and tables, notebooks, zip; then Word, Excel, PowerPoint; then the simplified OpenDocument and RTF.
4. The window: file tabs, entry points, produced-file cards.
5. `verify:preview`, the audit, docs.

## 8. Decisions (defaults picked; say if any should change)

| # | Decision | Default |
|---|---|---|
| V1 | Where files show | As tabs of the browser pane |
| V2 | Native types (PDF, images, video, audio, HTML) | Chromium itself, in a `file:` tab |
| V3 | Office | Rendered in the viewer page; legacy `.doc` and `.ppt` offer the system's program |
| V4 | Can the assistant read a viewer tab | No |
| V5 | Unknown types | A card with Open in your program and Show in folder |

## 9. What was built (11 November 2026)

**Built and checked** (`npm run verify:preview`, 45 checks, with real files of every kind made by the check; 9 + 4 + 15 unit tests for the type map, the scheme's paths and the viewer's readers; the existing `verify:files` and `verify:ui` updated):

- Every row of the table in section 2 opens: PDF, images, video, audio and web pages in a tab on the file's own address (Chromium); Word, Excel (xlsx, xlsm, xlsb, xls, ods), PowerPoint, OpenDocument text and presentations, RTF, Markdown, notebooks, JSON, CSV and TSV, source and text files, and zip archives in the viewer page; anything else, and the old `.doc` and `.ppt`, as a card that says what the file is and why it is not shown.
- **Where it opens from:** Open on a file card under an answer (the old Open, with the computer's own program, is now its own button next to it, still only for documents), Open in the browser on a file in Develop's Files panel, and "Open a file…" in the pane's menu (the system's dialog). A file already open in the chat is shown again.
- **The pane for a file:** a file icon and the file's name on the tab, the path in the address bar (not typed over), no back or forward, and in the menu "Open in your own program" and "Show in its folder".
- **Isolation, all checked:** the viewer page has no `celeste`, `require` or `process`; it cannot fetch from the web, from `file:`, from another scheme, or with a token it was not given; a web page cannot read through `celeste-view://`; the assistant's tools and other programs never see a viewer tab; closing the chat closes its file tabs and forgets their tokens. The scheme answers only `viewer.html`, `assets/*` and `/__file/<token>/<name>` (path rules tested one by one, including `..`, encoded dots and back slashes).
- **The viewer itself is accessible:** every viewer page is a `main` landmark with the file's name as its heading, in both themes (axe, in `verify:preview`).

**Differences from the plan above, and what the build taught:**

- **Narrow panes.** The browser's pane is often narrow, so a Word page is shown at the size that fits it (never cut off), Markdown's contents list sits above the text there (closed to begin with), and the PowerPoint column and slide size follow the width.
- **PowerPoint.** `pptx-preview` draws real decks well (checked on a 30 KB deck made from a full Office template, kept in `scripts/fixtures/deck.pptx`) but gives up silently on a file with a minimal theme (decks made by some generators): the viewer then says "No slides could be read" instead of showing an empty page.
- **Excel.** A workbook is read to its first 5,000 rows a sheet, with the text each cell shows (dates and numbers as formatted); hidden sheets are left out.
- **Text.** A file ends with its last line (a trailing line break is not an empty line); a file over a megabyte is cut with a note. Find uses the page's own search.
- **Libraries:** `docx-preview`, `pptx-preview`, `jszip` and SheetJS 0.20.3 (from its own site: the npm copy is old and has two published vulnerabilities) are build-time dependencies that only the viewer page loads, each when its kind of file is opened; `THIRD_PARTY_NOTICES.md` lists them.

**Not checked by the script (do by hand):** video playing and seeking (the check shows MP4 and MOV are sent to Chromium but makes no video file); real Word, Excel and PowerPoint files of all kinds (the fidelity of layout, fonts, charts, SmartArt and animations is the libraries'); a very large file (the limit is 200 MB, the text cut is 1 MB); a PDF's own controls.

**Ideas for later:** syntax colours for code (no highlighter is in the app yet), `.docx` comments and tracked changes, a chart view for a sheet, EPUB, 3D models, opening a file by dropping it on the pane, and a Markdown link to a file next to the document.
