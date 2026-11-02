# Web Reader

A simple, private EPUB reader that runs entirely in your browser. Open a book from your
device or a link and read it on a calm sepia page set in Junicode (or Source Sans 3).
Your book and your place in it are remembered on this device.

**Open it:** <https://sipak-gh.github.io/webreader/>

Nothing is uploaded: books are unpacked and stored by your browser, and there is no server.

## Getting started

Open a book in any of these ways:

- **From your device:** click **Choose an EPUB…**, or **Open file…** in the **☰** menu,
  and pick an `.epub` file.
- **Drag and drop:** drop an `.epub` file anywhere on the page.
- **From a link:** open the **☰** menu, paste a link to an `.epub` file in the link bar
  and press **Enter** or **Go**.

The book opens where you left off, or at the beginning if it's new to you.

## Reading

The bar at the top looks like this:

```
Wide screens:  [☰]  [‹]  [Current chapter ▾]  [›]      [Serif] [2 col] [Justified] [A−] 12 pt [A+]
Phones:        [☰]  [‹]  [Current chapter ▾]  [›]
```

**‹** and **›** go to the previous and next chapter, and the chapter's name is also the
contents list: tap it to jump to any chapter. **☰** opens the menu, which shows the
book's title and author and which part of the book you're in (e.g. `3 / 15`), and holds
**Open file…** and the link bar. On phones the text settings are in the menu too. Tap
outside the menu or press **Esc** to close it.

| To… | Do this |
| --- | --- |
| Turn to the next page | **→**, **↓**, **Page Down** or **Space**; click or tap the right third of the page; swipe left; or scroll the mouse wheel down |
| Turn to the previous page | **←**, **↑** or **Page Up**; click or tap the left third of the page; swipe right; or scroll the wheel up |
| Go to the previous / next chapter | **‹** / **›**, or swipe right / left in the Scroll layout. Turning past the last page of a chapter also opens the next one. |
| Jump to a chapter | Choose it from the chapter name in the bar |
| Follow a link in the book (footnotes, cross-references) | Click it. Links to websites open in a new tab. |
| Switch between serif and sans-serif | **Serif** / **Sans** (in the **☰** menu on phones) |
| Change the layout | The layout button cycles through **Scroll**, **1 col**, **2 col**, **3 col** and **4 col** (in the **☰** menu on phones) |
| Switch between justified and ragged-right text | **Justified** / **Ragged** (in the **☰** menu on phones) |
| Change the text size | **A−** / **A+**, in points from 8 to 24 (in the **☰** menu on phones) |

**Pages.** With 1–4 columns, text is laid out in pages that fit the window, so there's
no scrolling: each page ends at the bottom of the screen and the page number is shown
beneath it (e.g. `Page 3 of 12`). Images are shrunk to fit on a page. The page fills 90%
of the window's width, however many columns it has. If the window is too narrow for the
number you picked, fewer are shown until it's wide enough again (hover over the button to
see).

**Scroll.** The whole chapter is one long page that you scroll through as on any website;
use **‹** / **›** or swipe left / right to change chapter. Taps don't turn pages in this
layout.

**Justified text.** By default paragraphs are justified (straight left and right edges)
and set by [Justif](https://justif.lyall.co), which picks the line breaks for a whole
paragraph at once, as TeX does, and hyphenates, so word spacing stays even. On wider
screens punctuation at the ends of lines hangs slightly into the margin, so the edges
look straight. Words are hyphenated in the book's language for Catalan, Croatian, Danish,
Dutch, English, Finnish, French, German, Greek, Hungarian, Italian, Norwegian, Polish,
Portuguese, Russian, Slovak, Slovenian, Spanish, Swedish, Turkish and Ukrainian; other
languages are justified without hyphens. If Justif can't run, the browser's own
justification is used. **Ragged** sets the text flush left instead.

**Defaults.** Until you choose, wide screens get 2 columns and 12 pt text, and phones
(and windows under 800 px wide) get Scroll and 16 pt text. 3 and 4 columns are for very
wide screens and are only used if you pick them. On phones the text runs almost to the
edges of the screen.

## What's remembered

On this device and browser, Web Reader remembers:

- the last book you opened (one book at a time);
- your chapter and page in it;
- your typeface, text size, layout and justification.

If you change the text size, layout or window size, the text is laid out again and you
stay at the same point in the chapter.

Reloading or coming back later picks up exactly where you were. Opening the **same**
book again (the same file, or the same link) keeps your place. Opening a **different**
book replaces the saved one and starts it from the beginning.

To forget everything, clear this site's data in your browser settings (often under
"Cookies and site data").

## Sharing a book

When you open a book from the link bar (in the **☰** menu), the page address changes to include it, e.g.:

```
https://sipak-gh.github.io/webreader/?source=https%3A%2F%2Fexample.com%2Fbook.epub
```

Send that address to someone and the book opens for them automatically. To build such a
link yourself, put the EPUB's URL in a `source` parameter, encoded with
`encodeURIComponent`:

```
https://sipak-gh.github.io/webreader/?source=https%3A%2F%2Fgithub.com%2Fsipak-gh%2Flearn-philosophy%2Fraw%2Frefs%2Fheads%2Fmaster%2Freadings%2Faristotle-politics-pg6762.epub
```

A base64-encoded URL also works: `?source=aHR0cHM6Ly9leGFtcGxlLmNvbS9ib29rLmVwdWI`.

Things to know about links:

- The book's website must allow other sites to download its files (CORS). GitHub's
  `raw.githubusercontent.com` does. Ordinary `github.com/…/raw/…` and `github.com/…/blob/…`
  links are converted to it automatically.
- If the link is for the book you already have saved, your saved copy and place are
  used and nothing is downloaded again.
- Opening a file from your device removes the link from the address, so reloading
  keeps your local book.

## Troubleshooting

| Message | What to do |
| --- | --- |
| *This EPUB is DRM-protected and cannot be opened.* | Books bought from some stores are locked to their own apps. Use a DRM-free copy (e.g. from Project Gutenberg or Standard Ebooks). |
| *Not a valid EPUB (ZIP) file* / *Not an EPUB* | The file is damaged or isn't an EPUB. Try downloading it again. |
| *Could not download …* (CORS) | The website doesn't allow downloads from other sites. Download the file and open it from your device instead. |
| *Download failed (HTTP 404)* | The link is wrong or the file has moved. |
| *The "source" link is not a valid http(s) URL.* | Check the link starts with `https://` (or is valid base64). |
| *This book could not be saved for next time* | Browser storage is full or disabled (e.g. some private windows). The book still opens, but won't be remembered. |
| *This browser is too old to open EPUB files.* | Update your browser. |

Picture books, comics and other fixed-layout EPUBs open, but they use Web Reader's own
simple styling instead of the book's design.

## Supported browsers

Current versions of Chrome, Edge, Firefox and Safari (Chrome/Edge 80+, Firefox 113+,
Safari 16.4+), on desktop and mobile.

## For developers

No build step and no dependencies: plain ES modules, type-checked with JSDoc
(`// @ts-check` + `jsconfig.json`).

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): code structure, data flow, storage and security model.
- [docs/EPUB-FORMAT.md](docs/EPUB-FORMAT.md): how EPUB files are laid out and how the app reads them.

Run locally (ES modules need `http://`, not `file://`):

```sh
python3 -m http.server 8000      # then open http://localhost:8000/
npx -p typescript tsc -p jsconfig.json   # optional type-check
```

Browser tests (Chromium; need Playwright): swipes on an emulated phone with real touch
input, and justified text under the reader frame's real Content-Security-Policy:

```sh
pip install playwright && python3 -m playwright install --with-deps chromium
python3 tests/mobile_swipe.py
python3 tests/justify.py
```

Deploy to GitHub Pages: push to the `master` branch. In **Settings → Pages**, choose
*Deploy from a branch*, then `master` and `/ (root)`. All paths are relative, so the app works
under `/webreader/`. `.nojekyll` makes Pages serve the files unchanged.

## Fonts and libraries

- [Junicode 2](https://github.com/psb1558/Junicode-font) by Peter S. Baker. SIL Open Font License 1.1, see `fonts/junicode/OFL.txt`.
- [Source Sans 3](https://github.com/adobe-fonts/source-sans) by Adobe. SIL Open Font License 1.1, see `fonts/source-sans/LICENSE.md`.
- [Justif](https://github.com/lyallcooper/justif) 0.9.2 by Lyall Cooper, with TeX hyphenation patterns. MIT License, see `vendor/justif/LICENSE`.
