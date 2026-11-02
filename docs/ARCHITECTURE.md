# Architecture

How Web Reader is put together. For the EPUB file format itself, see
[EPUB-FORMAT.md](EPUB-FORMAT.md). Every function and class is also documented in place
with JSDoc comments.

## Overview

Web Reader is a static site: HTML, CSS and plain ES-module JavaScript, with no build step,
no package manager and no server-side code. The one library, Justif, is vendored. Everything happens in the browser:

```
 .epub file / link
        │
        ▼
  zip.js  ──►  epub.js  ──►  reader.js  ──►  sandboxed <iframe>
 (unzip)      (parse)       (sanitise + render)
        ▲                         ▲
        └──────── app.js ─────────┘   ◄── toolbar, link bar, keyboard
                    │
                    ▼
               storage.js  (IndexedDB + localStorage)
```

## Files

```
index.html          Page shell: toolbar + ☰ menu, welcome screen, reader iframe, status toast
css/
  fonts.css         @font-face rules for Junicode and Source Sans 3
  app.css           Toolbar, drop-down menu, welcome screen and status styles
  reader.css        Book typography inside the reader frame
js/
  app.js            Entry point: wires the UI, opening, navigation and saving together
  zip.js            ZipArchive: minimal ZIP reader using DecompressionStream
  epub.js           Book: container → OPF → manifest, spine, table of contents
  reader.js         Reader: sanitises chapters and shows them in the iframe
  storage.js        Saves the book (IndexedDB), progress and preferences (localStorage)
  source.js         ?source= links: parsing, GitHub URL rewriting, download
  typeset.js        Runs inside the reader frame: gives reader.js Justif and hyphenators
vendor/justif/      Justif 0.9.2 (dist/ runtime files, typings, LICENSE; npm package
                    "justif"); hyphenate/ holds per-language patterns, loaded on demand
fonts/              Variable WOFF2 fonts and their licences
docs/               This document and the EPUB format guide
tests/
  mobile_swipe.py   Swipes on an emulated phone (Python + Playwright; not deployed code)
  justify.py        Justified text under the frame's real CSP (Python + Playwright)
jsconfig.json       Strict type-checking of the JS via JSDoc (editor / tsc only)
.nojekyll           Tells GitHub Pages to serve files as-is
```

## Modules

### `zip.js`

| Export | Purpose |
| --- | --- |
| `ZipArchive(buffer)` | Finds the End Of Central Directory record, indexes every entry. |
| `.names` / `.has(name)` | List / test entries (lookups fall back to case-insensitive). |
| `.read(name)` | Bytes of one file; method 0 is copied, method 8 is inflated with `DecompressionStream('deflate-raw')`. |
| `.readText(name)` | `read` + UTF-8 decode. |
| `ZipError` | Not a ZIP, damaged, ZIP64 or encrypted entry. |

### `epub.js`

| Export | Purpose |
| --- | --- |
| `Book.open(buffer)` | Unzip, reject DRM, read `container.xml`, parse the OPF and table of contents. |
| `book.title`, `author`, `language` | Metadata from Dublin Core elements. |
| `book.manifest`, `spine`, `toc` | All files, the reading order, and the flattened contents list. |
| `book.loadDocument(path)` | Parse a chapter: strict XHTML first, HTML parser as fallback. |
| `book.resourceUrl(path)` | Cached `blob:` URL for an image or other file. |
| `book.spineIndexOf(path)` | Map a link target to a chapter index. |
| `book.destroy()` | Revoke all `blob:` URLs. |
| `resolveHref(base, href)` | Resolve a relative, percent-encoded href to a ZIP path + fragment. |
| `isExternalHref(href)` | Whether an href has a URL scheme. |
| `EpubError` | Missing parts, malformed XML, DRM, no content. |

### `reader.js`

| Export | Purpose |
| --- | --- |
| `Reader(frame, events)` | Owns the iframe; `events` are callbacks to `app.js`. |
| `.init()` | Load the frame template and attach listeners inside it. |
| `.show(book, index, position)` | Sanitise and display a chapter, wait for images/fonts, lay it out (pages or scroll), go to a fragment or fraction. Returns `false` if a newer call superseded it. |
| `.turnPage(±1)` | Turn a page (or scroll a screenful) within the chapter; returns `false` at the first/last page (the app then changes chapter). |
| `.page` / `.pageCount` | Current page (0-based) and pages in the chapter (always 0 / 1 when scrolling). |
| `.scrolling` | Whether the scroll layout is in use. |
| `.getFraction()` / `.setFraction(f)` | Read / set the position as `page / pageCount`, or `scrollTop / scrollHeight` when scrolling (0–1). |
| `.showFragment(id)` | Go to the page holding an element in the current chapter. |
| `.columns` / `.columnSetting` | Columns actually shown / layout chosen: `SCROLL` (0) or 1–4 (the preference, or automatically 2 at 800 px and wider, else `SCROLL`). |
| `.applyPrefs(prefs)` | Async. Set font, size (pt), layout and justification, then re-render the chapter at the same position so nothing is left off-page. |
| `MAX_COLUMNS` / `SCROLL` | 4 / 0. |

Events sent to the app: `onTurn(±1)` (click on a page edge, wheel, swipe; not in the scroll layout),
`onChapter(±1)` (a swipe in the scroll layout), `onKey`,
`onLink(path, fragment)`, `onPageChange` (after a relayout or a page change the app
didn't ask for, or a scroll), `onFile` (a file dropped on the reader).

Clicks and touches are listened for on `#webreader-root`, not the document: iOS doesn't
send taps on plain text to document-level listeners. iOS also only sends touches to
listeners inside a frame if the parent page has touch listeners over the frame, so a
no-op `touchstart` listener sits on the `<iframe>` itself. A swipe is a one-finger
gesture that travels at least 50 px sideways and 1.5× further sideways than vertically.
`tests/mobile_swipe.py` checks swipes on an emulated phone.

Internal helpers: `prepareContent` (sanitise), `rewriteLink`, `rewriteResource`, `waitForLayout`.

#### Justified text

With `justify` on, `reader.css` justifies `p`, `li`, `dd` and `blockquote` (the
`JUSTIFIED` selector; `data-justify` on the frame's root) and, once a chapter's images
and fonts have loaded, `#render` passes those elements to
[Justif](https://justif.lyall.co). Justif re-sets each paragraph with Knuth–Plass line
breaking, hyphenation, optical margin alignment and slight letter-spacing and font-width
(Junicode's `wdth` axis) adjustments, keeping the text as inline HTML so links and
selection still work. It skips paragraphs it can't measure reliably (images, block
children), which keep the browser's justification. A chapter is shown with the browser's
justification first and re-set when Justif is ready.

Justif must run in the frame's own realm (it uses `instanceof Element`, the global
`document` and `document.fonts`), so the frame template loads `js/typeset.js`, which
puts `{ justify, hyphenator(language) }` on the frame's window as `webreaderTypeset`.
`init` reads it before any book content is in the frame (an element with that `id`
would otherwise appear as a window property). `hyphenator` maps the book's
`dc:language` to a pattern file as Justif's own `auto.js` does (English → en-us unless
en-GB, Norwegian → nb) and imports it once.

Justif watches the paragraphs' widths and fonts and re-sets them itself; its
`onRelayout` calls `#scheduleRelayout` so the page count follows. The controller is
destroyed before each render and when the settings change. Punctuation hangs into the
margins (`hangingPunctuation: 'line-end-only'`) only on frames 800 px and wider; phone
margins (8 px) are too thin, so there it's `'none'` (switched live on resize). The page
clip extends half a column gap past the page on each side so hung punctuation isn't cut
off. If Justif fails to load or throws, the browser's justification stays.

#### Pagination

The chapter goes in `<article id="webreader-content">` inside a clipping
`<div id="webreader-page">` that fills the frame minus the margins and the page number.
`#layout` gives the article that exact width and height plus `column-count: N` and
`column-fill: auto`. Text that doesn't fit flows into more columns to the right, so a
chapter becomes a horizontal strip of pages. A page is shown by moving the strip with
`transform: translateX(-page × stride)`, where `stride = page width + column gap`.

- **Columns:** the chosen number, reduced if columns would be narrower than 15 em.
  The page (all its columns) is 90% of the frame's width (`PAGE_SHARE`), centred, with
  no cap on line length. Below 800 px it fills the width less 8 px side margins
  (`NARROW_PAD`).
- **Page count:** an empty marker `<span>` is appended after the chapter; the page
  holding it is the last page.
- **Relayout** (keeping the fraction) happens when the frame resizes, fonts finish
  loading or an image loads.
- **Stray scrolling** of the clipped page (find-in-page, tabbing to a link) is reset
  and turned into the matching page.
- Headings avoid breaking from their text, and images are limited to the page height
  (`--page-height`).

#### Scroll layout

`#layout` sets `data-layout="scroll"` on the frame's root element (otherwise `pages`).
The column styles are removed and the frame document scrolls normally: the chapter is
one long page, with 8 px side margins on narrow frames and a centred column 90% of the
width from 800 px. Edge clicks and the wheel are left alone, and vertical swipes scroll;
a sideways swipe sends `onChapter` instead of `onTurn`. `#webreader-root` is at least as
tall as the frame, so swipes below a short chapter count too. A scroll reports
`onPageChange` so progress is saved. Images are still capped at the frame height.

### `storage.js`

| Export | Purpose |
| --- | --- |
| `saveBook` / `loadBook` | The current book's file in IndexedDB (one book only). |
| `saveProgress` / `loadProgress(bookId)` | Chapter + fraction of it; ignored if it belongs to another book. |
| `savePrefs` / `loadPrefs` | Font, size (pt) and columns, with defaults for bad values. |

### `source.js`

| Export | Purpose |
| --- | --- |
| `parseSource(value)` | Plain or base64 URL → `URL`; must be http(s). |
| `normalizeSourceUrl(url)` | `github.com/…/raw/…` or `/blob/…` → `raw.githubusercontent.com/…` (the former has no CORS). |
| `download(url, onProgress)` | Fetch without cookies, streaming progress. |
| `getSourceParam` / `setSourceParam` / `clearSourceParam` | Read / write / remove `?source=` without reloading. |
| `fileNameFromUrl(url)` | Display name for messages. |
| `SourceError` | Bad link or failed download (message is user-facing). |

### `app.js`

Holds the app state (`book`, `bookId`, `prefs`) and the toolbar. Key functions:

| Function | Purpose |
| --- | --- |
| `start()` | Startup sequence (below). |
| `openFile(file)` | Open button, file picker, drag and drop. |
| `openLink()` | Link bar submit. |
| `openUrl(url, stored)` | Shared by `?source=` and the link bar; uses the saved copy if it's the same link. |
| `openBuffer(buffer, id, name)` | Parse, save, display. Leaves the current book open on failure. |
| `openStored(stored)` | Reopen the saved book. |
| `display(book, id, progress)` | Make a book current: toolbar, chapter list, menu, link bar, first chapter. |
| `goTo(index, position)` / `goRelative(±1)` / `followLink` | Chapter navigation; every move saves progress. |
| `turnPage(±1)` | Next/previous page; past either end of a chapter, opens the neighbouring chapter at its first/last page. |
| `handleKey(event)` | Page keys from the page and the reader frame (not while typing in a field; ↑ ↓ scroll natively in the scroll layout); Escape closes the menu. |
| `setMenuOpen(open)` | Show/hide the ☰ drop-down menu and the backdrop that closes it. |
| `placeTextSettings()` | Text settings go on the right of the toolbar on wide screens and into the menu below 800 px (`narrowScreen` media query); re-applies the automatic text size when that changes. |
| `textSize()` | The chosen size, or automatically 12 pt (wide) / 16 pt (narrow). |
| `updateChrome(fragment)` | Prev/next state, "n / total", selected contents entry. |
| `saveNow` / `scheduleSave` | Save progress now / 250 ms after the last page turn. |
| `applyPrefs` / `changeSize` / `cycleColumns` | Font toggle, A− / A+ (8–24 pt), layout Scroll → 1 → 2 → 3 → 4 → Scroll. |
| `updateColumnsButton` | Shows the layout (`Scroll` or `N col`); the tooltip says whether it's automatic or reduced to fit. |

## Flows

### Startup

1. If `DecompressionStream` or IndexedDB is missing, show an "old browser" message.
2. `reader.init()`, apply saved preferences, load the saved book (if any).
3. If `?source=` is present and valid, `openUrl`: same link as the saved book → reopen
   the saved copy (no download); otherwise download.
4. Otherwise, or if that failed, reopen the saved book at its saved position.
   If the link failed, its error stays on screen.
5. Otherwise show the welcome screen.

### Opening a book

- **Local file** (Open button, welcome button, drop on the page or the reader):
  `openFile` → `openBuffer` with id `name:size:lastModified`. On success, `?source=`
  is removed and the link bar is cleared.
- **Link bar**: `openLink` parses the text (plain or base64). If it's already the open
  book it says so. Otherwise `openUrl` downloads it (Go is disabled meanwhile). On
  success `?source=` is set to the link, so reloading or sharing the page address
  reopens it. On failure, the current book and the typed text are kept.
- **`?source=`**: see Startup.

`openBuffer` saves the file to IndexedDB, then `display` resumes from saved progress
if the id matches (same file or same link) or starts at the beginning.

### Reading and navigation

- Page keys (← ↑ PageUp / → ↓ PageDown Space), clicks on the left/right third of
  the page, swipes and the wheel (one page per gesture) call `turnPage`.
- In the scroll layout, sideways swipes call `goRelative` (start of the previous/next chapter).
- The toolbar ‹ › buttons, the chapter list in the toolbar and in-book links call `goTo`.
- A link within the current chapter only changes page; others render the target
  chapter and go to the page holding the fragment.
- `Reader.show` uses a render token so rapid clicks can't show chapters out of order.

### Saving progress

`{ bookId, spineIndex, fraction }` is written to localStorage after every navigation,
250 ms after the last page turn, and on `pagehide` / when the tab is hidden. A fraction
(`page / pageCount`) rather than a page number is stored, so the position survives
changes to the font, text size, layout and window size.

## Storage

| Where | Key | Value |
| --- | --- | --- |
| IndexedDB `webreader` → store `books` | `current` | `{ id, name, blob }`: the EPUB file |
| localStorage | `webreader:progress` | `{ bookId, spineIndex, fraction }` |
| localStorage | `webreader:prefs` | `{ font: 'serif' \| 'sans', size, columns, justify }`: size in pt, or `null` for automatic (12 wide, 16 narrow); columns 0 (scroll) or 1–4, or `null` for automatic; justify `true` (default) or `false` for ragged right |

Book ids: `name:size:lastModified` for local files, `url:<normalised URL>` for links.
`navigator.storage.persist()` is requested so the browser is less likely to evict the book.

## Security model

EPUB chapters are untrusted HTML, so there are several layers of protection:

1. **Content-Security-Policy.** The frame template has `script-src 'nonce-…'` with a
   random nonce made for each session, and one script tag carrying it: `js/typeset.js`.
   Modules it imports inherit the nonce. Nothing else can run in the frame, whatever
   the content: no `<script>` (inline or same-origin), no `on*` attributes, no
   `javascript:` URLs. Book content can't learn the nonce: it can't run script, and
   its styles are removed (so no CSS attribute selectors can probe it). The page's own policy
   (`script-src 'self'`) also applies to the frame.
2. **Sandbox.** The iframe has `sandbox="allow-same-origin allow-scripts"`, which blocks
   forms, popups, top navigation and plugins. `allow-same-origin` lets `app.js` fill the
   frame and listen to it. `allow-scripts` is needed only because Safari (every iOS
   browser) won't deliver the frame's events to `app.js`'s listeners without it
   ([WebKit bug 218086](https://bugs.webkit.org/show_bug.cgi?id=218086)); the CSP is what
   stops scripts. Browsers warn that this pair of flags lets a script escape the
   sandbox, but the only script that can run there is our own typesetting code.
3. **Sanitising** (`prepareContent`). Removes `script`, `style`, `link`, `meta`, `base`,
   frames, `object`/`embed`; `on*`, `style`, `srcset` and `data-webreader-*` attributes;
   and non-http(s)/mailto link schemes. Images become `blob:` URLs.

Internal links are handled by the app rather than navigating the frame. External links
open in a new tab with `noopener,noreferrer`. Downloads use `credentials: 'omit'`.
Local files never leave the device.

## Styling

- `reader.css` is the only styling for book content; the book's own CSS is dropped.
  In the pages layout it never scrolls (`overflow: hidden`); `data-layout="scroll"`
  switches to normal scrolling. `--font-size` (in pt), `data-font` and `data-justify`
  are set by `Reader.applyPrefs`; `--page-height` by `#layout`.
- `app.css` styles the page, including the one-row toolbar (☰, ‹, chapter list, ›, and
  the text settings on wide screens) and the drop-down menu that holds everything else. Both share the sepia palette (`--paper`, `--ink`, `--accent`).

## Limitations

- No ZIP64 (EPUBs over 4 GB or with over 65,535 files).
- DRM-protected books are refused. Font obfuscation is allowed, but obfuscated fonts
  aren't used anyway.
- The book's CSS and fonts are ignored, so fixed-layout and heavily designed books
  (comics, children's books) won't look as intended.
- One book is stored at a time.
- Linked books must be served with CORS (`Access-Control-Allow-Origin`).

## Development

```sh
python3 -m http.server 8000      # ES modules need http://, not file://
npx -p typescript tsc -p jsconfig.json   # optional strict type-check
python3 tests/mobile_swipe.py    # swipe test; needs: pip install playwright && python3 -m playwright install --with-deps chromium
python3 tests/justify.py         # justified text (Justif) under the frame's real CSP
```

Deploy: push to `master` on GitHub. In Settings → Pages, deploy from branch `master`, folder `/ (root)`.
