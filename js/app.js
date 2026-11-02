// @ts-check

/**
 * @file Application entry point (loaded by index.html). Connects the toolbar
 * (‹ chapter list ›, and the ☰ menu with the open button, link bar and text settings),
 * the {@link Reader},
 * storage and `?source=` links.
 *
 * Startup ({@link start}):
 *  1. Check browser support, set up the reader frame and apply saved preferences.
 *  2. If the address has `?source=`, open that book (from the saved copy if it's the
 *     same link, otherwise by downloading it).
 *  3. Otherwise reopen the saved book at the saved position, or show the welcome screen.
 *
 * Every way of opening a book ends in {@link openBuffer} or {@link openStored}, which
 * call {@link display}. Chapter navigation goes through {@link goTo} and page turns
 * through {@link turnPage}; both save progress.
 */

import { Book } from './epub.js';
import { MAX_COLUMNS, Reader, SCROLL } from './reader.js';
import * as storage from './storage.js';
import { clearSourceParam, download, fileNameFromUrl, getSourceParam, parseSource, setSourceParam } from './source.js';

/** @typedef {import('./reader.js').Position} Position */

/**
 * Looks up a required element of index.html.
 * @param {string} id
 * @returns {HTMLElement}
 * @throws {Error} If the element is missing (index.html and app.js are out of sync).
 */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

// Elements from index.html.
const openButton = /** @type {HTMLButtonElement} */ (byId('open-button'));
const welcomeOpenButton = /** @type {HTMLButtonElement} */ (byId('welcome-open-button'));
const fileInput = /** @type {HTMLInputElement} */ (byId('file-input'));
const urlForm = /** @type {HTMLFormElement} */ (byId('url-form'));
const urlInput = /** @type {HTMLInputElement} */ (byId('url-input'));
const urlButton = /** @type {HTMLButtonElement} */ (byId('url-button'));
const titleEl = byId('book-title');
const controls = byId('chapter-controls');
const prevButton = /** @type {HTMLButtonElement} */ (byId('prev-button'));
const nextButton = /** @type {HTMLButtonElement} */ (byId('next-button'));
const tocSelect = /** @type {HTMLSelectElement} */ (byId('toc'));
const positionEl = byId('position');
const fontButton = /** @type {HTMLButtonElement} */ (byId('font-button'));
const columnsButton = /** @type {HTMLButtonElement} */ (byId('columns-button'));
const justifyButton = /** @type {HTMLButtonElement} */ (byId('justify-button'));
const smallerButton = /** @type {HTMLButtonElement} */ (byId('smaller-button'));
const sizeLabel = byId('size-label');
const largerButton = /** @type {HTMLButtonElement} */ (byId('larger-button'));
const toolbar = byId('toolbar');
const menu = byId('menu');
const menuButton = /** @type {HTMLButtonElement} */ (byId('menu-button'));
const menuBackdrop = byId('menu-backdrop');
const welcome = byId('welcome');
const frame = /** @type {HTMLIFrameElement} */ (byId('reader'));
const statusEl = byId('status');

const prefsGroup = byId('prefs');

/** Smallest text size in points (A− stops here). */
const MIN_SIZE = 8;
/** Largest text size in points (A+ stops here). */
const MAX_SIZE = 24;
/** Text size in points until the user picks one, on wide screens. */
const DEFAULT_SIZE = 12;
/** Text size in points until the user picks one, on narrow screens (phones). */
const NARROW_DEFAULT_SIZE = 16;
/**
 * Matches narrow screens: below the 800 px at which the reader switches from scrolling to
 * pages (same breakpoint as css/app.css). There the text settings move into the menu and
 * the default text size is larger.
 */
const narrowScreen = window.matchMedia('(max-width: 799.98px)');

/** @type {Book | null} The open book. */
let book = null;
/** Identity of the open book, used to match saved progress (see {@link openBuffer}). */
let bookId = '';
/** Current display preferences. */
let prefs = storage.loadPrefs();
/** @type {ReturnType<typeof setTimeout> | undefined} Pending debounced progress save. */
let saveTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} Pending auto-hide of the status message. */
let statusTimer;

/** The reader frame; its callbacks route clicks, page turns, keys, layout changes and drops back here. */
const reader = new Reader(frame, {
  onLink: followLink,
  onTurn: turnPage,
  onChapter: goRelative,
  onKey: handleKey,
  onPageChange: () => {
    updateColumnsButton();
    scheduleSave();
  },
  onFile: openFile,
});

/**
 * Shows a message in the status toast at the bottom of the page.
 * @param {string} message  Text to show; `''` hides the toast.
 * @param {{ error?: boolean, timeout?: number }} [options]  `error` styles it as an
 *   error; `timeout` is in ms (default 5000), and 0 keeps the message up.
 */
function showStatus(message, { error = false, timeout = 5000 } = {}) {
  clearTimeout(statusTimer);
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
  statusEl.hidden = !message;
  if (message && timeout > 0) statusTimer = setTimeout(() => (statusEl.hidden = true), timeout);
}

/**
 * Turns a thrown value into a message for the user.
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens a book the user picked or dropped. Its id is name + size + modification
 * time, so opening the same file again resumes where the reader left off.
 * @param {File} file
 * @returns {Promise<void>}
 */
async function openFile(file) {
  showStatus(`Opening ${file.name}…`, { timeout: 0 });
  /** @type {ArrayBuffer} */
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    console.error(error);
    showStatus(`Could not open ${file.name}: ${describeError(error)}`, { error: true, timeout: 8000 });
    return;
  }
  if (await openBuffer(buffer, `${file.name}:${file.size}:${file.lastModified}`, file.name)) {
    // A local file replaces any ?source= book, so a reload shouldn't fetch that again.
    clearSourceParam();
  }
}

/**
 * Opens a book from a link (`?source=` or the link bar). If that same link is the
 * saved book, the saved copy is used so progress is kept and it works offline.
 * @param {URL} url  The book's URL, already parsed by `parseSource`.
 * @param {import('./storage.js').StoredBook | undefined} stored  The saved book, if any.
 * @returns {Promise<boolean>} True if a book was opened; on failure an error is shown.
 */
async function openUrl(url, stored) {
  const id = `url:${url.href}`;
  if (stored?.id === id && (await openStored(stored))) return true;

  const name = fileNameFromUrl(url);
  showStatus(`Downloading ${name}…`, { timeout: 0 });
  /** @type {ArrayBuffer} */
  let buffer;
  try {
    buffer = await download(url, (fraction) => {
      if (fraction !== null) showStatus(`Downloading ${name}… ${Math.round(fraction * 100)}%`, { timeout: 0 });
    });
  } catch (error) {
    console.error(error);
    showStatus(describeError(error), { error: true, timeout: 10000 });
    return false;
  }
  return openBuffer(buffer, id, name);
}

/**
 * Parses a book link (plain or base64), showing an error if it's invalid.
 * @param {string} value  Text from `?source=` or the link bar.
 * @returns {URL | null}
 */
function parseLink(value) {
  try {
    return parseSource(value);
  } catch (error) {
    showStatus(describeError(error), { error: true, timeout: 8000 });
    return null;
  }
}

/**
 * Opens the link in the link bar. On success the link is also put in the address bar
 * as `?source=`, so a reload reopens it and the page address can be shared.
 * @returns {Promise<void>}
 */
async function openLink() {
  const value = urlInput.value.trim();
  if (!value) {
    urlInput.focus();
    return;
  }
  const url = parseLink(value);
  if (!url) return;
  if (book && bookId === `url:${url.href}`) {
    showStatus('This book is already open.');
    return;
  }
  urlButton.disabled = true;
  try {
    if (await openUrl(url, undefined)) setSourceParam(url);
  } finally {
    urlButton.disabled = false;
  }
}

/**
 * Parses, saves and displays a book. Leaves the current book open on failure.
 * A save failure (e.g. storage full) is reported but the book still opens.
 * @param {ArrayBuffer} buffer  Contents of the `.epub` file.
 * @param {string} id           Book identity: `name:size:lastModified` for local files, `url:<href>` for links.
 * @param {string} name         File name for messages.
 * @returns {Promise<boolean>} True if the book was opened.
 */
async function openBuffer(buffer, id, name) {
  /** @type {Book} */
  let next;
  try {
    next = await Book.open(buffer);
  } catch (error) {
    console.error(error);
    showStatus(`Could not open ${name}: ${describeError(error)}`, { error: true, timeout: 8000 });
    return false;
  }

  let saved = true;
  try {
    await storage.saveBook({ id, name, blob: new Blob([buffer], { type: 'application/epub+zip' }) });
  } catch (error) {
    console.error(error);
    saved = false;
  }

  // Re-opening the same book keeps its progress; a different book starts fresh.
  await display(next, id, storage.loadProgress(id));
  if (saved) showStatus('');
  else showStatus('This book could not be saved for next time (browser storage may be full).', { error: true });
  return true;
}

/**
 * Reopens the book saved in IndexedDB at its saved position.
 * @param {import('./storage.js').StoredBook} stored
 * @returns {Promise<boolean>} True if it opened; errors are logged, not shown.
 */
async function openStored(stored) {
  try {
    const restored = await Book.open(await stored.blob.arrayBuffer());
    await display(restored, stored.id, storage.loadProgress(stored.id));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

/**
 * Makes a parsed book the open book: updates the toolbar and chapter list, shows
 * the saved (or first) chapter, then frees the previous book's resources.
 * @param {Book} next                                         The book to show.
 * @param {string} id                                         Its identity.
 * @param {import('./storage.js').Progress | null} progress   Where to resume, or null for the start.
 * @returns {Promise<void>}
 */
async function display(next, id, progress) {
  const previous = book;
  book = next;
  bookId = id;

  setMenuOpen(false);
  welcome.hidden = true;
  frame.hidden = false;
  controls.hidden = false;
  titleEl.textContent = next.author ? `${next.title} — ${next.author}` : next.title;
  titleEl.title = titleEl.textContent;
  // Like a browser's address bar, the link bar shows where the open book came from.
  urlInput.value = id.startsWith('url:') ? id.slice('url:'.length) : '';
  document.title = `${next.title} · Web Reader`;
  buildToc(next);

  const index = Math.min(Math.max(progress?.spineIndex ?? 0, 0), next.spine.length - 1);
  await goTo(index, { fraction: progress?.fraction ?? 0 });
  if (previous && previous !== next) void previous.destroy();
}

/**
 * Moves to a chapter (and optionally a position in it), updates the toolbar and
 * saves progress. A link within the current chapter just turns to the right page.
 * Out-of-range indexes are ignored.
 * @param {number} index            Spine index.
 * @param {Position} [position]     Fragment or fraction; defaults to the first page.
 * @returns {Promise<void>}
 */
async function goTo(index, position = {}) {
  if (!book || index < 0 || index >= book.spine.length) return;
  if (reader.book === book && reader.index === index && position.fragment) {
    reader.showFragment(position.fragment);
    updateChrome(position.fragment);
    saveNow();
    return;
  }
  try {
    if (!(await reader.show(book, index, position))) return;
  } catch (error) {
    console.error(error);
    showStatus(`Could not display this chapter: ${describeError(error)}`, { error: true });
    return;
  }
  updateChrome(position.fragment);
  saveNow();
}

/**
 * Moves to the start of the previous or next chapter.
 * @param {number} delta  -1 for previous, 1 for next.
 */
function goRelative(delta) {
  if (book && reader.book === book) void goTo(reader.index + delta);
}

/**
 * Turns the page. Past the last page of a chapter this opens the next chapter at its
 * first page; before the first page it opens the previous chapter at its last page.
 * @param {number} delta  -1 for the previous page, 1 for the next.
 */
function turnPage(delta) {
  if (!book || reader.book !== book) return;
  if (reader.turnPage(delta)) {
    scheduleSave();
    return;
  }
  const index = reader.index + delta;
  if (index >= 0 && index < book.spine.length) void goTo(index, { fraction: delta < 0 ? 1 : 0 });
}

/**
 * Follows an internal link clicked in the book. Links to files outside the reading
 * order are ignored.
 * @param {string} path      ZIP path of the target document.
 * @param {string} fragment  Target element id, or `''`.
 */
function followLink(path, fragment) {
  const index = book?.spineIndexOf(path) ?? -1;
  if (index >= 0) void goTo(index, { fragment });
}

/**
 * Fills the chapter list: the toolbar drop-down that names the current chapter. Option
 * values are indexes into `book.toc`; nesting is shown with em-space indentation.
 * @param {Book} current
 */
function buildToc(current) {
  const placeholder = new Option('Contents', '');
  placeholder.disabled = true;
  tocSelect.replaceChildren(placeholder);
  current.toc.forEach((entry, i) => {
    tocSelect.add(new Option(`${'\u2003'.repeat(entry.depth)}${entry.label}`, String(i)));
  });
}

/**
 * Updates the toolbar for the current chapter: enables/disables prev/next, shows
 * "chapter / total" and selects the matching contents entry.
 * @param {string} [fragment]  Fragment just navigated to, to pick the exact contents entry.
 */
function updateChrome(fragment = '') {
  if (!book) return;
  const index = reader.index;
  const last = book.spine.length - 1;
  prevButton.disabled = index <= 0;
  nextButton.disabled = index >= last;
  positionEl.textContent = `${index + 1} / ${last + 1}`;

  // Highlight the exact TOC entry if we jumped to one, else the first entry for this
  // chapter, else the closest preceding one.
  let best = book.toc.findIndex((entry) => entry.spineIndex === index && entry.fragment === fragment);
  if (best < 0) {
    book.toc.forEach((entry, i) => {
      if (entry.spineIndex <= index && (best < 0 || entry.spineIndex > (book?.toc[best].spineIndex ?? 0))) best = i;
    });
  }
  tocSelect.value = best >= 0 ? String(best) : '';
}

/** Saves the current chapter and position in it immediately, cancelling any pending save. */
function saveNow() {
  clearTimeout(saveTimer);
  if (!book || reader.book !== book) return;
  storage.saveProgress({ bookId, spineIndex: reader.index, fraction: reader.getFraction() });
}

/** Saves progress 250 ms after the last call (debounced, for rapid page turns and layout changes). */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

/**
 * Opens or closes the drop-down menu (book details, open file, link bar and text
 * settings). While open, a backdrop over the reader closes it when tapped.
 * @param {boolean} open
 */
function setMenuOpen(open) {
  menu.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  menuBackdrop.hidden = !open;
}

/** Keys that turn to the previous page. */
const PREVIOUS_PAGE_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp']);
/** Keys that turn to the next page. */
const NEXT_PAGE_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ']);

/**
 * Keyboard shortcuts, for both this page and the reader frame: ← ↑ PageUp turn back a
 * page; → ↓ PageDown Space turn forward; Escape closes the menu. Ignored with modifier
 * keys, while typing in a form control, and for Space on a focused button (which should
 * press the button). In the scroll layout ↑ and ↓ are left to scroll normally.
 * @param {KeyboardEvent} event
 */
function handleKey(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'Escape' && !menu.hidden) {
    setMenuOpen(false);
    menuButton.focus();
    return;
  }
  if (reader.scrolling && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return;
  const target = /** @type {Element | null} */ (event.target);
  const tag = target?.tagName ?? '';
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (event.key === ' ' && tag === 'BUTTON')) return;
  const delta = PREVIOUS_PAGE_KEYS.has(event.key) ? -1 : NEXT_PAGE_KEYS.has(event.key) ? 1 : 0;
  if (delta === 0) return;
  event.preventDefault();
  turnPage(delta);
}

/**
 * The text size in points: the user's choice, or the automatic size for this screen.
 * @returns {number}
 */
function textSize() {
  return prefs.size ?? (narrowScreen.matches ? NARROW_DEFAULT_SIZE : DEFAULT_SIZE);
}

/** Applies {@link prefs} to the toolbar buttons and the reader, and saves them. */
function applyPrefs() {
  if (prefs.size !== null) prefs = { ...prefs, size: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(prefs.size))) };
  const size = textSize();
  fontButton.textContent = prefs.font === 'serif' ? 'Serif' : 'Sans';
  fontButton.dataset.font = prefs.font;
  justifyButton.textContent = prefs.justify ? 'Justified' : 'Ragged';
  justifyButton.title = prefs.justify
    ? 'Text: justified, with even spacing and hyphenation (Justif). Click for ragged right.'
    : 'Text: ragged right. Click to justify.';
  smallerButton.disabled = size <= MIN_SIZE;
  largerButton.disabled = size >= MAX_SIZE;
  sizeLabel.textContent = `${size} pt`;
  sizeLabel.title = prefs.size === null ? 'Text size (automatic)' : 'Text size';
  void reader.applyPrefs({ ...prefs, size });
  updateColumnsButton();
  storage.savePrefs(prefs);
}

/**
 * Shows the layout on its button: "Scroll" or "N col". In automatic mode this is the
 * automatic choice for the current width. The tooltip notes when the window is too
 * narrow for that many columns.
 */
function updateColumnsButton() {
  const setting = reader.columnSetting;
  const mode = prefs.columns === null ? ' (automatic)' : '';
  if (setting === SCROLL) {
    columnsButton.textContent = 'Scroll';
    columnsButton.title = `Layout: one scrolling page per chapter${mode}. Click to change.`;
    return;
  }
  columnsButton.textContent = `${setting} col`;
  const fitted = reader.columns < setting ? `; ${reader.columns} fit at this width` : '';
  columnsButton.title = `Layout: pages of ${setting} column${setting > 1 ? 's' : ''}${mode}${fitted}. Click to change.`;
}

/**
 * Cycles the layout Scroll → 1 → 2 → 3 → 4 columns → Scroll, starting from what is
 * shown now. The choice is saved, which ends automatic mode.
 */
function cycleColumns() {
  prefs = { ...prefs, columns: (reader.columnSetting + 1) % (MAX_COLUMNS + 1) };
  applyPrefs();
  scheduleSave();
}

/**
 * Changes the text size by whole points, within {@link MIN_SIZE}–{@link MAX_SIZE}.
 * @param {number} delta  Points to add, e.g. 1 or -1.
 */
function changeSize(delta) {
  prefs = { ...prefs, size: textSize() + delta };
  applyPrefs();
  scheduleSave();
}

/**
 * Puts the text settings on the right of the toolbar on wide screens, or at the end of
 * the menu on narrow ones, and updates the automatic text size if the width class changed.
 */
function placeTextSettings() {
  const parent = narrowScreen.matches ? menu : toolbar;
  if (prefsGroup.parentElement === parent) return;
  if (narrowScreen.matches) menu.append(prefsGroup);
  else menu.before(prefsGroup);
  if (prefs.size === null) applyPrefs();
}

/** Opens the browser's file picker (the hidden `<input type="file">`). */
function chooseFile() {
  fileInput.click();
}

// Toolbar and welcome screen.
openButton.addEventListener('click', chooseFile);
welcomeOpenButton.addEventListener('click', chooseFile);
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) void openFile(file);
});
urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openLink();
});
prevButton.addEventListener('click', () => goRelative(-1));
nextButton.addEventListener('click', () => goRelative(1));
tocSelect.addEventListener('change', () => {
  const entry = book?.toc[Number(tocSelect.value)];
  setMenuOpen(false);
  if (entry) void goTo(entry.spineIndex, { fragment: entry.fragment });
});
menuButton.addEventListener('click', () => setMenuOpen(Boolean(menu.hidden)));
menuBackdrop.addEventListener('click', () => setMenuOpen(false));
fontButton.addEventListener('click', () => {
  prefs = { ...prefs, font: prefs.font === 'serif' ? 'sans' : 'serif' };
  applyPrefs();
  scheduleSave();
});
justifyButton.addEventListener('click', () => {
  prefs = { ...prefs, justify: !prefs.justify };
  applyPrefs();
  scheduleSave();
});
columnsButton.addEventListener('click', cycleColumns);
// The reader reports its own resizes; this keeps the automatic label right on the welcome screen.
window.addEventListener('resize', updateColumnsButton);
narrowScreen.addEventListener('change', placeTextSettings);
smallerButton.addEventListener('click', () => changeSize(-1));
largerButton.addEventListener('click', () => changeSize(1));
document.addEventListener('keydown', handleKey);

// Drag and drop onto the page chrome (drops on the reader frame go through Reader's onFile).
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

// Save before the page is closed, reloaded or backgrounded (mobile browsers may not fire pagehide).
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});

/**
 * Starts the app: checks browser support, then opens the `?source=` book, the saved
 * book, or the welcome screen (see the file header for the order).
 * @returns {Promise<void>}
 */
async function start() {
  if (typeof DecompressionStream === 'undefined' || typeof indexedDB === 'undefined') {
    welcome.hidden = false;
    showStatus('This browser is too old to open EPUB files. Please use a current version of Firefox, Chrome or Safari.', {
      error: true,
      timeout: 0,
    });
    return;
  }

  await reader.init();
  placeTextSettings();
  applyPrefs();

  /** @type {import('./storage.js').StoredBook | undefined} */
  let stored;
  try {
    stored = await storage.loadBook();
  } catch (error) {
    console.error(error);
  }
  const sourceValue = getSourceParam();
  const sourceUrl = sourceValue ? parseLink(sourceValue) : null;
  if (sourceUrl && (await openUrl(sourceUrl, stored))) return;
  // On a failed ?source= load the error stays up while we fall back to the saved book.
  const sourceFailed = Boolean(sourceValue);

  if (stored) {
    if (!sourceFailed) showStatus(`Reopening ${stored.name}…`, { timeout: 0 });
    if (await openStored(stored)) {
      if (!sourceFailed) showStatus('');
      return;
    }
    if (!sourceFailed) {
      showStatus('Your saved book could not be reopened. Please open it again.', { error: true, timeout: 0 });
    }
  }
  welcome.hidden = false;
}

start().catch((error) => {
  console.error(error);
  welcome.hidden = false;
  showStatus(`Something went wrong: ${describeError(error)}`, { error: true, timeout: 0 });
});
