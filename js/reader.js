// @ts-check

/**
 * @file Displays one chapter at a time inside a sandboxed iframe, either as one long
 * scrolling page ("scroll" layout) or as fixed-size pages of one to four columns that
 * the reader turns.
 *
 * Chapter documents come straight from the EPUB, so they're treated as untrusted:
 *  - The frame's document has a Content-Security-Policy that only runs the script tag
 *    carrying a random per-session nonce (see {@link frameDocument}): js/typeset.js,
 *    which typesets justified text, and the modules it imports. No script inside a book
 *    can run. The iframe's sandbox has to include `allow-scripts`: Safari won't call
 *    this page's event listeners on a frame sandboxed without it (WebKit bug 218086),
 *    which breaks taps, swipes and links.
 *  - {@link prepareContent} also removes scripts, styles, embeds and event-handler
 *    attributes, and rewrites links and images so they work inside the frame.
 *
 * Pagination uses CSS multi-column layout. The chapter `<article>` gets a fixed height
 * and a width of N columns. Content that doesn't fit flows into extra "overflow"
 * columns to the right, so each run of N columns is one page. The article is shifted
 * with `transform: translateX(…)` to show a page, inside a clipping viewport
 * (`#webreader-page`). All sizes are whole pixels so pages don't drift.
 *
 *     ┌──────── viewport (page width) ────────┐
 *     │ col 1 │ gap │ col 2 │ gap ║ col 3 │ gap │ col 4 │ …   ← article, shifted left
 *     └──────────────── page 1 ───────────────┘║─────── page 2 ───
 *                       stride = page width + gap
 *
 * In the scroll layout none of this applies: the article is a normal block and the
 * frame's document scrolls.
 *
 * The iframe's document is created once from {@link frameDocument}; each chapter's nodes
 * are imported into its `<article>`. When justified text is on, paragraphs are then set
 * by Justif, which runs inside the frame (see js/typeset.js); browsers that can't run
 * it keep the browser's own justification. This module listens for clicks, taps,
 * swipes, wheel, keys and file drops inside the frame and forwards them to the app
 * through {@link ReaderEvents}.
 */

import { isExternalHref, resolveHref } from './epub.js';

/** @typedef {import('./epub.js').Book} Book */
/** @typedef {import('./storage.js').Prefs} Prefs */
/** @typedef {import('./typeset.js').Typesetter} Typesetter */
/** @typedef {import('../vendor/justif/index.js').JustifyController} JustifyController */

/**
 * Callbacks the app supplies to react to things that happen inside the reader frame.
 * @typedef {object} ReaderEvents
 * @property {(path: string, fragment: string) => void} onLink  An internal book link was clicked.
 * @property {(delta: number) => void} onTurn  The user asked for the previous (-1) or next (1)
 *   page by clicking/tapping a page edge, swiping or using the mouse wheel.
 * @property {(delta: number) => void} onChapter  The user swiped to the previous (-1) or next (1)
 *   chapter in the scroll layout.
 * @property {(event: KeyboardEvent) => void} onKey  A key was pressed while the frame had focus.
 * @property {() => void} onPageChange  The position changed without the app asking: the layout
 *   changed (resize, late images or fonts), or the reader scrolled in the scroll layout.
 *   Not fired while a chapter is rendering.
 * @property {(file: File) => void} onFile  A file was dropped onto the reader.
 */

/**
 * Where to go after showing a chapter. `fragment` wins if both are given; with
 * neither, the chapter opens on its first page.
 * @typedef {object} Position
 * @property {string} [fragment]  Element id to show.
 * @property {number} [fraction]  Position in the chapter, 0 (start) – 1 (end; shows the last page).
 */

/**
 * The reader frame's document: our stylesheets, the typesetting script, a clipping page
 * viewport and a page number.
 *
 * The CSP runs only the script tag carrying `nonce`, and the modules it imports (which
 * inherit the nonce); any other script in the frame (inline, src, on* attributes,
 * javascript: links) is blocked. It doesn't affect the listeners this module adds,
 * which run in the app's own window. Relative URLs inside srcdoc resolve against this
 * page, so the stylesheets and script load from our site.
 * @param {string} nonce  Random, base64; unguessable by book content.
 * @returns {string}
 */
const frameDocument = (nonce) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="css/fonts.css">
<link rel="stylesheet" href="css/reader.css">
<script type="module" src="js/typeset.js" nonce="${nonce}"></script>
</head>
<body>
<div id="webreader-root">
<div id="webreader-page"><article id="webreader-content"></article></div>
<div id="webreader-folio" aria-live="polite"></div>
</div>
</body>
</html>`;

/** Space above the page, in px. */
const PAD_TOP = 32;
/** Space below the page, in px (holds the page number). */
const PAD_BOTTOM = 44;
/** Gap between columns, in em of the body text. */
const GAP_EM = 2.5;
/** Columns narrower than this (in em) are too cramped; fewer columns are used instead. */
const MIN_COLUMN_EM = 15;
/** On wide frames the page (all its columns) fills this share of the width, centred. */
const PAGE_SHARE = 0.9;
/** Side margin (px) on narrow frames (phones), just enough to keep text off the screen edge. */
const NARROW_PAD = 8;
/** Frame width (px) from which the automatic layout uses two-column pages instead of scrolling. */
const AUTO_PAGES_WIDTH = 800;
/** Largest selectable column count. */
export const MAX_COLUMNS = 4;
/** Column setting that means the scroll layout (the whole chapter on one scrolling page). */
export const SCROLL = 0;
/** Horizontal swipe distance (px) that turns a page on touch screens. */
const SWIPE_DISTANCE = 50;
/** Wheel events closer together than this (ms) count as one gesture, turning one page. */
const WHEEL_GESTURE_GAP = 250;
/** Elements Justif sets when justified text is on. css/reader.css must justify the same ones. */
const JUSTIFIED = 'p, li, dd, blockquote';

/** Elements removed from chapters: active content, book styles and things that change the document's base or metadata. */
const BLOCKED_ELEMENTS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
]);

/**
 * Attributes that point at files in the EPUB, by element name. Their values are
 * replaced with blob: URLs by {@link rewriteResource}.
 * @type {Record<string, string[]>}
 */
const RESOURCE_ATTRIBUTES = {
  img: ['src'],
  image: ['href', 'xlink:href'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
};

/**
 * Renders chapters of a {@link Book} into an iframe, as pages or as a scrolling page,
 * and tracks the reading position.
 * Call {@link Reader#init} once before anything else.
 *
 * @example
 * const reader = new Reader(iframe, { onLink, onTurn, onChapter, onKey, onPageChange, onFile });
 * await reader.init();
 * await reader.applyPrefs({ font: 'serif', size: 12, columns: null, justify: true });
 * await reader.show(book, 0);
 * reader.turnPage(1);
 */
export class Reader {
  /** @type {HTMLIFrameElement} The sandboxed frame chapters are shown in. */
  #frame;
  /** @type {ReaderEvents} Callbacks into the app. */
  #events;
  /** @type {Document | null} The frame's document, once initialised. */
  #doc = null;
  /** @type {HTMLElement | null} Clipping box that shows exactly one page. */
  #viewport = null;
  /** @type {HTMLElement | null} The multi-column `<article>` that holds the current chapter. */
  #content = null;
  /** @type {HTMLElement | null} Page number shown under the page. */
  #folio = null;
  /** @type {HTMLElement | null} Empty marker after the chapter's last node; its position gives the page count. */
  #end = null;
  /** Incremented on every {@link Reader#show}; lets a slow render detect it was superseded. */
  #renderToken = 0;
  /** True while a chapter is being laid out, so layout changes aren't reported. */
  #rendering = false;
  /** @type {number | null} Layout preference: {@link SCROLL}, 1–4 columns, or null for automatic. */
  #columnPref = null;
  /** True in the scroll layout, false when showing pages. */
  #scrolling = false;
  /** Columns actually used by the current layout (1 in the scroll layout). */
  #columns = 1;
  /** Distance in px from one page to the next (page width + one gap). */
  #stride = 1;
  /** Zero-based page within the current chapter. */
  #page = 0;
  /** Number of pages in the current chapter. */
  #pageCount = 1;
  /** Pending requestAnimationFrame id for a re-layout, or 0. */
  #relayoutFrame = 0;
  /** True from the first wheel event of a gesture until it ends. */
  #wheelLocked = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} Ends the current wheel gesture. */
  #wheelTimer;
  /** @type {{ x: number, y: number } | null} Where the current touch started. */
  #touchStart = null;
  /** @type {Typesetter | null} Justif, from js/typeset.js in the frame; null if it didn't load. */
  #typesetter = null;
  /** Whether to justify text (with Justif when it loaded). */
  #justify = true;
  /** @type {JustifyController | null} Justif's control over the current chapter's paragraphs. */
  #justifier = null;
  /** @type {'none' | 'line-end-only'} The hanging punctuation the current Justif controller uses. */
  #hanging = 'none';
  /** @type {Book | null} The book currently shown. */
  book = null;
  /** Spine index of the chapter currently shown. */
  index = 0;

  /**
   * @param {HTMLIFrameElement} frame  An iframe with `sandbox="allow-same-origin allow-scripts"`.
   * @param {ReaderEvents} events      Callbacks for user interaction inside the frame.
   */
  constructor(frame, events) {
    this.#frame = frame;
    this.#events = events;
  }

  /** Zero-based page currently shown within the chapter. */
  get page() {
    return this.#page;
  }

  /** Number of pages in the current chapter at the current layout. */
  get pageCount() {
    return this.#pageCount;
  }

  /** Columns per page in the current layout (may be fewer than {@link Reader#columnSetting} on narrow frames). */
  get columns() {
    return this.#columns;
  }

  /** True in the scroll layout (the chapter is one scrolling page). */
  get scrolling() {
    return this.#scrolling;
  }

  /**
   * The layout the user's setting resolves to at the current frame width: the chosen
   * {@link SCROLL} or 1–4 columns, or for automatic mode 2 columns on wide frames and
   * scrolling on narrow ones (phones). Pages may still use fewer columns if they would
   * be too narrow.
   * @returns {number}
   */
  get columnSetting() {
    if (this.#columnPref !== null) return this.#columnPref;
    // The frame is hidden (width 0) on the welcome screen; use the window width there.
    const width = this.#doc?.documentElement.clientWidth || this.#frame.clientWidth || window.innerWidth;
    return width >= AUTO_PAGES_WIDTH ? 2 : SCROLL;
  }

  /**
   * Loads the frame template and attaches event listeners to the frame's document.
   * @returns {Promise<void>}
   * @throws {Error} If the frame's document isn't accessible.
   */
  async init() {
    const loaded = new Promise((resolve) => this.#frame.addEventListener('load', resolve, { once: true }));
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
    this.#frame.srcdoc = frameDocument(nonce);
    await loaded;

    const doc = this.#frame.contentDocument;
    const win = this.#frame.contentWindow;
    const root = doc?.getElementById('webreader-root');
    const viewport = doc?.getElementById('webreader-page');
    const content = doc?.getElementById('webreader-content');
    const folio = doc?.getElementById('webreader-folio');
    if (!doc || !win || !root || !viewport || !content || !folio) throw new Error('Reader frame failed to initialise.');
    this.#doc = doc;
    this.#viewport = viewport;
    this.#content = content;
    this.#folio = folio;
    // Module scripts run before the load event. Read it now, before any book content is in
    // the frame: an element with this id would otherwise show up as a window property.
    const typesetter = /** @type {Partial<Typesetter> | undefined} */ (Reflect.get(win, 'webreaderTypeset'));
    if (typeof typesetter?.justify === 'function' && typeof typesetter.hyphenator === 'function') {
      this.#typesetter = /** @type {Typesetter} */ (typesetter);
    } else {
      console.warn('Justif did not load; using the browser’s justification.');
    }

    // On an element rather than the document: iOS doesn't send taps on plain text to
    // click listeners on the document.
    root.addEventListener('click', (event) => this.#onClick(event));
    doc.addEventListener('keydown', (event) => this.#events.onKey(event));
    doc.addEventListener('wheel', (event) => this.#onWheel(event), { passive: true });
    // On the element for the same reason as clicks. iOS also only delivers touches inside
    // a frame if the parent page has touch listeners over it, hence the no-op one here.
    this.#frame.addEventListener('touchstart', () => {}, { passive: true });
    root.addEventListener('touchstart', (event) => this.#onTouchStart(event), { passive: true });
    root.addEventListener('touchend', (event) => this.#onTouchEnd(event), { passive: true });
    root.addEventListener('touchcancel', () => (this.#touchStart = null), { passive: true });
    doc.addEventListener('dragover', (event) => event.preventDefault());
    doc.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (file) this.#events.onFile(file);
    });

    // Anything that changes text size or image sizes changes the page count.
    win.addEventListener('resize', () => this.#scheduleRelayout());
    doc.fonts.addEventListener('loadingdone', () => this.#scheduleRelayout());
    doc.addEventListener(
      'load',
      (event) => {
        if (/** @type {Node} */ (event.target).nodeName.toLowerCase() === 'img') this.#scheduleRelayout();
      },
      true,
    );

    // The viewport clips with overflow:hidden, but find-in-page or tabbing to a link can
    // still scroll it. Turn that scroll into the matching page instead.
    viewport.addEventListener('scroll', () => {
      if (this.#scrolling || (viewport.scrollLeft === 0 && viewport.scrollTop === 0)) return;
      const page = Math.floor((this.#page * this.#stride + viewport.scrollLeft + 1) / this.#stride);
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      this.#setPage(page);
      if (!this.#rendering) this.#events.onPageChange();
    });
    // In the scroll layout, scrolling is reading progress.
    win.addEventListener('scroll', () => {
      if (this.#scrolling && !this.#rendering) this.#events.onPageChange();
    });

    this.#layout();
  }

  /**
   * Renders a spine item, lays it out, then goes to the requested position once
   * images and fonts have loaded (so the page count is accurate). Focuses the frame
   * so the keyboard works straight away.
   * @param {Book} book             The book to show.
   * @param {number} index          Spine index of the chapter.
   * @param {Position} [position]   Where to go; defaults to the start.
   * @returns {Promise<boolean>} False if a newer `show` call superseded this one.
   * @throws {RangeError} If `index` is outside the spine.
   */
  async show(book, index, position = {}) {
    const shown = await this.#render(book, index, position);
    if (shown) this.#frame.contentWindow?.focus();
    return shown;
  }

  /**
   * Does the work of {@link Reader#show}, without moving the focus.
   * @param {Book} book
   * @param {number} index
   * @param {Position} position
   * @returns {Promise<boolean>} False if superseded by a newer render.
   */
  async #render(book, index, position) {
    const { doc, content } = this.#parts();
    const token = ++this.#renderToken;
    const item = book.spine[index];
    if (!item) throw new RangeError(`No chapter at index ${index}`);

    const source = await book.loadDocument(item.path);
    const body = source.body ?? source.documentElement;
    await prepareContent(body, book, item.path);
    if (token !== this.#renderToken) return false;

    this.#rendering = true;
    try {
      const end = doc.createElement('span');
      end.setAttribute('aria-hidden', 'true');
      this.#unjustify();
      content.replaceChildren(...Array.from(body.childNodes, (node) => doc.importNode(node, true)), end);
      this.#end = end;
      this.book = book;
      this.index = index;
      const language = book.language || 'en';
      doc.documentElement.lang = language;
      // Go to the position now (approximately, as images may still be loading) and
      // again once the layout is final.
      const go = () => {
        this.#layout();
        if (position.fragment) this.showFragment(position.fragment);
        else this.setFraction(position.fraction ?? 0);
      };
      go();
      await waitForLayout(content);
      if (token !== this.#renderToken) return false;
      if (!(await this.#justifyContent(language, token))) return false;
      go();
    } finally {
      if (token === this.#renderToken) this.#rendering = false;
    }
    return true;
  }

  /**
   * When justified text is on, has Justif set the chapter's paragraphs (in the
   * browser's justification until then), and waits until it has settled. Justif
   * re-sets them itself when their width changes and reports it, so the page count
   * is updated then. If Justif fails, the browser's justification stays.
   * @param {string} language  The book's language, for hyphenation.
   * @param {number} token     The render's token (see `#renderToken`).
   * @returns {Promise<boolean>} False if superseded by a newer render.
   */
  async #justifyContent(language, token) {
    const typesetter = this.#typesetter;
    if (!this.#justify || !typesetter) return true;
    const hyphenate = await typesetter.hyphenator(language);
    if (token !== this.#renderToken) return false;
    try {
      const { content } = this.#parts();
      this.#hanging = this.#hangingPunctuation();
      this.#justifier = typesetter.justify(content.querySelectorAll(JUSTIFIED), {
        hyphenate,
        hangingPunctuation: this.#hanging,
        onRelayout: () => this.#scheduleRelayout(),
      });
      await Promise.race([this.#justifier.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
    } catch (error) {
      console.warn('Justif failed; using the browser’s justification.', error);
      this.#unjustify();
    }
    return token === this.#renderToken;
  }

  /** Gives the current chapter's paragraphs back to the browser's own layout. */
  #unjustify() {
    try {
      this.#justifier?.destroy();
    } catch (error) {
      console.warn('Justif failed to restore the text.', error);
    }
    this.#justifier = null;
  }

  /**
   * Whether Justif should hang punctuation (hyphens, stops, quotes) wholly outside the
   * line ends: not on narrow frames (phones), whose margins are too thin to hold it.
   * Small optical adjustments at the line ends stay on either way.
   * @returns {'none' | 'line-end-only'}
   */
  #hangingPunctuation() {
    return (this.#doc?.documentElement.clientWidth ?? 0) < AUTO_PAGES_WIDTH ? 'none' : 'line-end-only';
  }

  /**
   * Shows the page containing the element with this id (or legacy `name` anchor).
   * Shows the first page if it doesn't exist.
   * @param {string} fragment  Element id, without `#`.
   */
  showFragment(fragment) {
    const { content } = this.#parts();
    const target = content.querySelector(`[id="${CSS.escape(fragment)}"], [name="${CSS.escape(fragment)}"]`);
    if (!target) {
      this.setFraction(0);
      return;
    }
    const scroller = this.#doc?.scrollingElement;
    if (this.#scrolling && scroller) {
      scroller.scrollTop += target.getBoundingClientRect().top - this.#em();
      return;
    }
    // Both rects include the current translateX, so the difference is the offset in the chapter.
    const offset = target.getBoundingClientRect().left - content.getBoundingClientRect().left;
    this.#setPage(Math.floor((offset + 1) / this.#stride));
  }

  /**
   * Turns the page within the current chapter. In the scroll layout, scrolls by a
   * screenful (less a couple of lines, so the reader doesn't lose their place).
   * @param {number} delta  -1 for the previous page, 1 for the next.
   * @returns {boolean} False if already on the first/last page, or at the top/bottom
   *   when scrolling (the app then changes chapter).
   */
  turnPage(delta) {
    const scroller = this.#doc?.scrollingElement;
    if (this.#scrolling && scroller) {
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (delta > 0 ? scroller.scrollTop >= max - 1 : scroller.scrollTop <= 0) return false;
      scroller.scrollTop += delta * Math.max(this.#em(), scroller.clientHeight - 3 * this.#em());
      return true;
    }
    const target = this.#page + delta;
    if (target < 0 || target >= this.#pageCount) return false;
    this.#setPage(target);
    return true;
  }

  /**
   * How far through the current chapter the reader is: the start of the current page
   * (or the top of the screen when scrolling) as a fraction of the chapter. Saved as
   * progress because it survives changes to layout, font size and window size.
   * @returns {number} 0 (start) up to, but not including, 1.
   */
  getFraction() {
    const scroller = this.#doc?.scrollingElement;
    if (this.#scrolling && scroller) {
      return scroller.scrollHeight > 0 ? Math.min(1, scroller.scrollTop / scroller.scrollHeight) : 0;
    }
    return this.#pageCount > 1 ? this.#page / this.#pageCount : 0;
  }

  /**
   * Shows the page (or scrolls to the point) at a fraction of the current chapter.
   * @param {number} fraction  0 (start) – 1 (end). 1 shows the last page / the bottom.
   */
  setFraction(fraction) {
    const scroller = this.#doc?.scrollingElement;
    if (this.#scrolling && scroller) {
      // The browser clamps this to the bottom.
      scroller.scrollTop = Math.round(fraction * scroller.scrollHeight);
      return;
    }
    // The epsilon absorbs rounding so page/pageCount maps back to the same page.
    this.#setPage(Math.floor(fraction * this.#pageCount + 1e-6));
  }

  /**
   * Applies the font family, size (read by css/reader.css as `data-font` and
   * `--font-size`), justification (`data-justify`) and layout, keeping the reader at
   * the same place in the text.
   * The chapter is then rendered again from scratch, so nothing is left laid out for
   * the old size (Safari can otherwise leave text outside the page).
   * @param {Prefs & { size: number }} prefs  With the text size resolved (not automatic).
   * @returns {Promise<void>} Resolves once the chapter has been rendered again.
   */
  async applyPrefs(prefs) {
    const root = this.#doc?.documentElement;
    if (!root) return;
    const fraction = this.getFraction();
    // Justif would re-set the old paragraphs for the new settings, only for the render
    // below to replace them.
    if (!this.#rendering) this.#unjustify();
    root.dataset.font = prefs.font;
    root.style.setProperty('--font-size', `${prefs.size}pt`);
    root.toggleAttribute('data-justify', prefs.justify);
    this.#justify = prefs.justify;
    this.#columnPref = prefs.columns;
    this.#layout();
    this.setFraction(fraction);
    // A render in progress does its final layout with these settings anyway.
    if (this.book && !this.#rendering) await this.#render(this.book, this.index, { fraction });
  }

  /**
   * The frame's document and content element.
   * @returns {{ doc: Document, content: HTMLElement }}
   * @throws {Error} If {@link Reader#init} hasn't completed.
   */
  #parts() {
    if (!this.#doc || !this.#content) throw new Error('Reader not initialised.');
    return { doc: this.#doc, content: this.#content };
  }

  /** The body text size in px (1 em of the chapter text). */
  #em() {
    return parseFloat(this.#doc?.defaultView?.getComputedStyle(this.#content ?? this.#doc.body).fontSize ?? '') || 16;
  }

  /**
   * Sizes the page and columns for the current frame size, font size and column
   * setting, then recounts pages. In the scroll layout, removes the page geometry. The current page index is kept (clamped); callers
   * that want to keep the reading position use {@link Reader#getFraction} around it.
   */
  #layout() {
    const viewport = this.#viewport;
    const content = this.#content;
    const root = this.#doc?.documentElement;
    if (!viewport || !content || !root) return;

    const setting = this.columnSetting;
    this.#scrolling = setting === SCROLL;
    root.dataset.layout = this.#scrolling ? 'scroll' : 'pages';
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (this.#scrolling) {
      viewport.removeAttribute('style');
      content.removeAttribute('style');
      root.style.setProperty('--page-height', `${height}px`);
      this.#columns = 1;
      this.#stride = 1;
      this.#pageCount = 1;
      this.#setPage(0);
      return;
    }

    const em = this.#em();
    const gap = Math.round(em * GAP_EM);
    const narrow = width < AUTO_PAGES_WIDTH;
    const padX = narrow ? NARROW_PAD : Math.round(Math.min(48, Math.max(16, width * 0.04)));
    // Phones use all but the side margins; wider frames a centred 90% (within the margins).
    const available = Math.max(1, narrow ? width - 2 * padX : Math.min(width - 2 * padX, Math.round(width * PAGE_SHARE)));

    // Use the chosen column count unless the columns would become too narrow.
    const fit = Math.max(1, Math.floor((available + gap) / (MIN_COLUMN_EM * em + gap)));
    const columns = Math.min(setting, fit);
    const columnWidth = Math.max(1, Math.floor((available - (columns - 1) * gap) / columns));
    const pageWidth = columns * columnWidth + (columns - 1) * gap;
    const pageHeight = Math.max(1, height - PAD_TOP - PAD_BOTTOM);

    // The clip extends half a gap past the page on each side: Justif hangs punctuation
    // into the margins. The neighbouring pages are a whole gap away, so stay hidden.
    const bleed = Math.floor(gap / 2);
    Object.assign(viewport.style, {
      left: `${Math.floor((width - pageWidth) / 2) - bleed}px`,
      top: `${PAD_TOP}px`,
      width: `${pageWidth + 2 * bleed}px`,
      height: `${pageHeight}px`,
    });
    Object.assign(content.style, {
      marginLeft: `${bleed}px`,
      width: `${pageWidth}px`,
      height: `${pageHeight}px`,
      columnCount: String(columns),
      columnGap: `${gap}px`,
    });
    // Lets css/reader.css keep images within one page.
    root.style.setProperty('--page-height', `${pageHeight}px`);

    this.#columns = columns;
    this.#stride = pageWidth + gap;
    this.#pageCount = this.#countPages();
    this.#setPage(this.#page);
  }

  /**
   * Counts pages from the position of the end marker: the page holding it is the last.
   * @returns {number} At least 1.
   */
  #countPages() {
    if (!this.#end || !this.#content) return 1;
    const offset = this.#end.getBoundingClientRect().left - this.#content.getBoundingClientRect().left;
    return Math.max(1, Math.floor((offset + 1) / this.#stride) + 1);
  }

  /**
   * Shows a page (clamped to the chapter) and updates the page number.
   * @param {number} page  Zero-based page index.
   */
  #setPage(page) {
    this.#page = Math.min(Math.max(0, page), this.#pageCount - 1);
    if (this.#scrolling) {
      if (this.#folio) this.#folio.textContent = '';
      return;
    }
    if (this.#content) this.#content.style.transform = `translateX(${-this.#page * this.#stride}px)`;
    if (this.#folio) {
      this.#folio.textContent = this.book ? `Page ${this.#page + 1} of ${this.#pageCount}` : '';
    }
  }

  /**
   * Re-lays out on the next animation frame (coalescing bursts of resize/load events),
   * keeping the reading position, then tells the app.
   */
  #scheduleRelayout() {
    if (this.#relayoutFrame) return;
    this.#relayoutFrame = requestAnimationFrame(() => {
      this.#relayoutFrame = 0;
      // Mid-render, show() does its own final layout.
      if (this.#rendering) return;
      const hanging = this.#hangingPunctuation();
      if (this.#justifier && hanging !== this.#hanging) {
        // Justif re-sets the text and reports it, which comes back here.
        this.#hanging = hanging;
        this.#justifier.applyLayoutOptions({ hangingPunctuation: hanging });
      }
      const fraction = this.getFraction();
      const wasScrolling = this.#scrolling;
      this.#layout();
      // While scrolling, the browser keeps the place itself, and setting the scroll
      // position would stop a fling.
      if (!(wasScrolling && this.#scrolling)) this.setFraction(fraction);
      this.#events.onPageChange();
    });
  }

  /**
   * Handles clicks in the frame: internal links (handed to the app), external links
   * (opened in a new tab, without access to this page), and, when showing pages,
   * clicks/taps on the left or right third of the page, which turn the page.
   * @param {MouseEvent} event
   */
  #onClick(event) {
    // Nodes inside the frame belong to another realm, so `instanceof Element` would be false.
    const target = /** @type {Node | null} */ (event.target);
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {Element} */ (target);

    const link = el.closest('a');
    if (link) {
      event.preventDefault();
      const external = link.getAttribute('data-webreader-external');
      if (external) {
        window.open(external, '_blank', 'noopener,noreferrer');
        return;
      }
      const path = link.getAttribute('data-webreader-path');
      if (path !== null) this.#events.onLink(path, link.getAttribute('data-webreader-fragment') ?? '');
      return;
    }

    // Don't turn the page when scrolling or when the click finished a text selection.
    if (this.#scrolling || this.#doc?.getSelection()?.isCollapsed === false) return;
    const width = this.#doc?.documentElement.clientWidth ?? 0;
    if (event.clientX < width / 3) this.#events.onTurn(-1);
    else if (event.clientX > (width * 2) / 3) this.#events.onTurn(1);
  }

  /**
   * Turns one page per wheel/trackpad gesture, so momentum scrolling doesn't skip pages.
   * Ctrl+wheel (browser zoom) is ignored, and so is everything in the scroll layout
   * (the frame just scrolls).
   * @param {WheelEvent} event
   */
  #onWheel(event) {
    if (event.ctrlKey || this.#scrolling) return;
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    clearTimeout(this.#wheelTimer);
    this.#wheelTimer = setTimeout(() => (this.#wheelLocked = false), WHEEL_GESTURE_GAP);
    if (this.#wheelLocked || Math.abs(delta) < 4) return;
    this.#wheelLocked = true;
    this.#events.onTurn(delta > 0 ? 1 : -1);
  }

  /**
   * Remembers where a single-finger touch started, for swipe detection.
   * @param {TouchEvent} event
   */
  #onTouchStart(event) {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    this.#touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  /**
   * On a mostly-horizontal swipe (left for next, right for previous) turns the page,
   * or in the scroll layout changes chapter. Vertical swipes are left to scroll.
   * @param {TouchEvent} event
   */
  #onTouchEnd(event) {
    const start = this.#touchStart;
    const touch = event.changedTouches[0];
    this.#touchStart = null;
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    const delta = dx < 0 ? 1 : -1;
    if (this.#scrolling) this.#events.onChapter(delta);
    else this.#events.onTurn(delta);
  }
}

/**
 * Strips active/unwanted content and rewrites links and resources so they work
 * from inside the reader frame. Book CSS is dropped in favour of our reading styles.
 *
 * Removed: {@link BLOCKED_ELEMENTS}, `on*` event handlers, `style` and `srcset`
 * attributes, and any `data-webreader-*` attributes a book might use to spoof ours.
 *
 * @param {Element} root         The chapter's `<body>` (modified in place).
 * @param {Book} book            Source of images and other resources.
 * @param {string} chapterPath   ZIP path of the chapter; relative hrefs resolve against it.
 * @returns {Promise<void>} Resolves once every resource has its blob: URL.
 */
async function prepareContent(root, book, chapterPath) {
  /** @type {Promise<void>[]} */
  const pending = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.localName.toLowerCase();
    if (BLOCKED_ELEMENTS.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcset' || name.startsWith('data-webreader-')) {
        el.removeAttributeNode(attr);
      }
    }
    if (tag === 'a') rewriteLink(el, chapterPath);
    for (const name of RESOURCE_ATTRIBUTES[tag] ?? []) {
      const value = el.getAttribute(name);
      if (value !== null) pending.push(rewriteResource(el, name, value, book, chapterPath));
    }
  }
  await Promise.all(pending);
}

/**
 * Prepares a link for {@link Reader#onClick}:
 *  - internal links get `data-webreader-path`/`-fragment` (the ZIP path and target id);
 *  - http(s)/mailto links get `data-webreader-external`;
 *  - links with any other scheme (e.g. `javascript:`) lose their href.
 * @param {Element} el           An `<a>` element (HTML or SVG).
 * @param {string} chapterPath   ZIP path of the chapter containing the link.
 */
function rewriteLink(el, chapterPath) {
  const href = el.getAttribute('href') ?? el.getAttribute('xlink:href');
  if (href === null) return;
  el.removeAttribute('xlink:href');
  el.removeAttribute('target');
  if (isExternalHref(href)) {
    if (/^(https?|mailto):/i.test(href)) {
      el.setAttribute('href', href);
      el.setAttribute('data-webreader-external', href);
    } else {
      el.removeAttribute('href');
    }
    return;
  }
  const { path, fragment } = resolveHref(chapterPath, href);
  el.setAttribute('href', '#');
  el.setAttribute('data-webreader-path', path);
  el.setAttribute('data-webreader-fragment', fragment);
}

/**
 * Points a resource attribute (e.g. `<img src>`) at a blob: URL for the file in the
 * EPUB. `data:` and http(s) URLs are kept; other schemes and missing files are removed.
 * @param {Element} el           Element carrying the attribute.
 * @param {string} name          Attribute name, e.g. `src` or `xlink:href`.
 * @param {string} value         The attribute's current value.
 * @param {Book} book            Book to load the file from.
 * @param {string} chapterPath   ZIP path of the chapter; the value is relative to it.
 * @returns {Promise<void>}
 */
async function rewriteResource(el, name, value, book, chapterPath) {
  if (/^(data|https?):/i.test(value)) return;
  if (isExternalHref(value)) {
    el.removeAttribute(name);
    return;
  }
  const url = await book.resourceUrl(resolveHref(chapterPath, value).path);
  if (url) el.setAttribute(name, url);
  else el.removeAttribute(name);
}

/**
 * Waits (bounded) for images and fonts so the page count and restored position are right.
 * Images that fail to load count as done.
 * @param {HTMLElement} root       Container whose images to wait for.
 * @param {number} [timeoutMs]     Give up after this long (default 3 s).
 * @returns {Promise<void>}
 */
async function waitForLayout(root, timeoutMs = 3000) {
  const images = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete);
  const imagesLoaded = images.map(
    (img) =>
      new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }),
  );
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([Promise.all([...imagesLoaded, root.ownerDocument.fonts.ready]), timeout]);
}
