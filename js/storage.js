// @ts-check

/**
 * @file Persistence, so the open book and reading position survive a reload.
 *
 *  - The EPUB file itself goes in IndexedDB (localStorage is ~5 MB and string-only).
 *    Only one book is kept; saving a new one replaces it.
 *  - Reading progress and preferences go in localStorage as small JSON values.
 *
 * Everything stays in the browser and is removed when the user clears site data.
 * localStorage failures (private mode, quota) are logged and ignored, so the reader
 * keeps working without persistence.
 */

/**
 * The book saved in IndexedDB.
 * @typedef {object} StoredBook
 * @property {string} id    Identity used to match saved progress (see app.js `openBuffer`).
 * @property {string} name  File name, shown while the book loads.
 * @property {Blob} blob    The original `.epub` file.
 */

/**
 * Where the reader is in a book.
 * @typedef {object} Progress
 * @property {string} bookId     The {@link StoredBook} id this progress belongs to.
 * @property {number} spineIndex Index of the current chapter in the book's spine.
 * @property {number} fraction   Position within the chapter, 0–1 (page / page count; 1 = last page).
 */

/**
 * Text display preferences.
 * @typedef {object} Prefs
 * @property {'serif' | 'sans'} font     Junicode (serif) or Source Sans 3 (sans).
 * @property {number | null} size        Body text size in points, or null for automatic
 *   (12 pt on wide screens, 16 pt on narrow ones) until the user picks one.
 * @property {number | null} columns     Layout: 0 to scroll (the whole chapter on one
 *   scrolling page), 1–4 columns per page, or null for automatic (2 columns on wide
 *   screens, scrolling on narrow ones) until the user picks one.
 * @property {boolean} justify           Justified text, set by Justif (the default), or
 *   ragged right.
 */

/** IndexedDB database name. */
const DB_NAME = 'webreader';
/** Object store holding the saved book. */
const STORE = 'books';
/** Key of the single saved book within {@link STORE}. */
const CURRENT_KEY = 'current';
/** localStorage key for {@link Progress}. */
const PROGRESS_KEY = 'webreader:progress';
/** localStorage key for {@link Prefs}. */
const PREFS_KEY = 'webreader:prefs';

/**
 * Preferences used before the user changes anything.
 * @type {Prefs}
 */
export const DEFAULT_PREFS = { font: 'serif', size: null, columns: null, justify: true };

/**
 * Opens (creating on first use) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Runs one request against the book store in its own transaction and closes the
 * database afterwards. Resolves only after the transaction commits.
 * @template T
 * @param {IDBTransactionMode} mode                          `'readonly'` or `'readwrite'`.
 * @param {(store: IDBObjectStore) => IDBRequest<T>} action  Issues the request.
 * @returns {Promise<T>} The request's result.
 */
async function withStore(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Saves a book, replacing any previously saved one, and asks the browser to keep
 * site data persistent.
 * @param {StoredBook} book
 * @returns {Promise<void>}
 * @throws {DOMException} If storage is unavailable or full.
 */
export async function saveBook(book) {
  await withStore('readwrite', (store) => store.put(book, CURRENT_KEY));
  // Ask the browser not to evict our data under storage pressure (best effort).
  navigator.storage?.persist?.().catch(() => {});
}

/**
 * Loads the saved book.
 * @returns {Promise<StoredBook | undefined>} The book, or undefined if none is saved.
 */
export function loadBook() {
  return withStore('readonly', (store) => store.get(CURRENT_KEY));
}

/**
 * Reads a JSON value from localStorage.
 * @param {string} key
 * @returns {unknown} The parsed value, or null if missing, invalid or inaccessible.
 */
function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

/**
 * Writes a JSON value to localStorage, logging (not throwing) on failure.
 * @param {string} key
 * @param {unknown} value  Any JSON-serialisable value.
 */
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not save ${key}`, error);
  }
}

/**
 * Loads saved progress if it belongs to the given book. Invalid fields are replaced
 * with the start of the book.
 * @param {string} bookId
 * @returns {Progress | null} Null if there's no progress for this book.
 */
export function loadProgress(bookId) {
  const value = /** @type {Partial<Progress> | null} */ (readJson(PROGRESS_KEY));
  if (!value || value.bookId !== bookId) return null;
  return {
    bookId,
    spineIndex: Number.isInteger(value.spineIndex) ? Number(value.spineIndex) : 0,
    fraction: typeof value.fraction === 'number' ? value.fraction : 0,
  };
}

/**
 * Saves reading progress (replacing progress for any other book).
 * @param {Progress} progress
 */
export function saveProgress(progress) {
  writeJson(PROGRESS_KEY, progress);
}

/**
 * Loads display preferences, using defaults for anything missing or invalid
 * (including preferences saved by older versions, which used a `scale` instead of `size`).
 * The size is not range-checked here; app.js clamps it.
 * @returns {Prefs}
 */
export function loadPrefs() {
  const value = /** @type {Partial<Prefs> | null} */ (readJson(PREFS_KEY));
  const columns = value?.columns;
  return {
    font: value?.font === 'sans' ? 'sans' : 'serif',
    size: typeof value?.size === 'number' && Number.isFinite(value.size) ? value.size : null,
    columns: Number.isInteger(columns) && Number(columns) >= 0 && Number(columns) <= 4 ? Number(columns) : null,
    justify: value?.justify !== false,
  };
}

/**
 * Saves display preferences.
 * @param {Prefs} prefs
 */
export function savePrefs(prefs) {
  writeJson(PREFS_KEY, prefs);
}
