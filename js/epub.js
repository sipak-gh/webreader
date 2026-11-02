// @ts-check

/**
 * @file EPUB parsing: turns a ZIP archive into a {@link Book} with metadata, reading
 * order (spine), table of contents and on-demand access to chapters and images.
 *
 * Parsing steps (see docs/EPUB-FORMAT.md for the file formats):
 *  1. `META-INF/encryption.xml` → refuse DRM-protected books ({@link assertNotDrm}).
 *  2. `META-INF/container.xml`  → path of the OPF package document ({@link Book.open}).
 *  3. OPF package               → metadata, manifest and spine (`Book#parsePackage`).
 *  4. Nav document or NCX       → table of contents (`Book#parseNav` / `Book#parseNcx`).
 */

import { ZipArchive } from './zip.js';

/**
 * A file listed in the OPF manifest.
 * @typedef {object} ManifestItem
 * @property {string} id          Manifest id, referenced by the spine.
 * @property {string} path        Full path inside the ZIP (already resolved and decoded).
 * @property {string} mediaType   MIME type declared by the publisher.
 * @property {string[]} properties  EPUB 3 item properties, e.g. `nav`, `cover-image`, `svg`.
 */

/**
 * One document in the reading order.
 * @typedef {object} SpineItem
 * @property {string} path     Full path inside the ZIP.
 * @property {boolean} linear  False for supplementary content (`linear="no"`), e.g. covers.
 */

/**
 * One line in the table of contents.
 * @typedef {object} TocEntry
 * @property {string} label       Text shown in the chapter list.
 * @property {number} spineIndex  Index of the target document in {@link Book#spine}.
 * @property {string} fragment    Element id within that document, or `''` for its start.
 * @property {number} depth       Nesting level, 0 for top-level entries.
 */

/** XHTML namespace; content documents parsed as XML must use it to render as HTML. */
export const XHTML_NS = 'http://www.w3.org/1999/xhtml';
/** EPUB "ops" namespace, used for the `epub:type` attribute. */
const OPS_NS = 'http://www.idpf.org/2007/ops';
/** Dublin Core namespace, used for OPF metadata (`dc:title`, `dc:creator`, …). */
const DC_NS = 'http://purl.org/dc/elements/1.1/';

/**
 * Font obfuscation algorithms. These are not DRM; any other algorithm listed in
 * `encryption.xml` means the book's content is locked.
 */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

/**
 * Fallback MIME types for resources the manifest doesn't describe. Blob URLs need a
 * correct type for some formats (notably SVG) to display.
 * @type {Record<string, string>}
 */
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** Thrown when a file is not a usable EPUB (missing parts, malformed XML, DRM, …). */
export class EpubError extends Error {}

/**
 * Whether an href points outside the book (has a URL scheme such as `https:` or `mailto:`).
 * @param {string} href
 * @returns {boolean}
 */
export function isExternalHref(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * Percent-decodes a string, returning it unchanged if it isn't validly encoded.
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves an href relative to the file it appears in, producing a ZIP path.
 *
 * Uses the browser's URL resolution on a dummy host so `../`, `./` and encoded
 * characters behave exactly as they would on the web.
 *
 * @example
 * resolveHref('OEBPS/Text/ch1.xhtml', '../Images/a%20b.png#x')
 * // → { path: 'OEBPS/Images/a b.png', fragment: 'x' }
 *
 * @param {string} basePath  Path of the referencing file inside the ZIP.
 * @param {string} href      The (percent-encoded) href or src value.
 * @returns {{ path: string, fragment: string }} Decoded ZIP path and `#fragment` (without `#`).
 */
export function resolveHref(basePath, href) {
  const encodedBase = basePath.split('/').map(encodeURIComponent).join('/');
  const url = new URL(href, `https://epub.invalid/${encodedBase}`);
  return { path: safeDecode(url.pathname.slice(1)), fragment: safeDecode(url.hash.slice(1)) };
}

/**
 * Parses XML strictly.
 * @param {string} text
 * @param {DOMParserSupportedType} [type]
 * @returns {Document}
 * @throws {EpubError} If the XML is malformed.
 */
function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length > 0) throw new EpubError('Malformed XML in EPUB.');
  return doc;
}

/**
 * Finds all descendant elements with a local name, whatever their namespace prefix
 * (OPF files write both `<item>` and `<opf:item>`).
 * @param {Document | Element} root
 * @param {string} localName
 * @returns {Element[]}
 */
function byTag(root, localName) {
  return Array.from(root.getElementsByTagNameNS('*', localName));
}

/**
 * Finds the direct children of an element with a local name.
 * @param {Element} el
 * @param {string} localName
 * @returns {Element[]}
 */
function childrenByTag(el, localName) {
  return Array.from(el.children).filter((child) => child.localName === localName);
}

/**
 * An element's text with whitespace collapsed and trimmed (`''` for a missing element).
 * @param {Element | null | undefined} el
 * @returns {string}
 */
function cleanText(el) {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A parsed EPUB. Create one with {@link Book.open}. Holds the book's metadata, reading
 * order and table of contents. Chapters and images are extracted lazily when requested.
 */
export class Book {
  /** @type {Map<string, ManifestItem>} Manifest items keyed by id. */
  manifest = new Map();
  /** @type {Map<string, ManifestItem>} Manifest items keyed by ZIP path. */
  #manifestByPath = new Map();
  /** @type {SpineItem[]} Documents in reading order. */
  spine = [];
  /** @type {TocEntry[]} Flattened table of contents, in document order. */
  toc = [];
  /** Book title from `dc:title`. */
  title = 'Untitled';
  /** First `dc:creator`, or `''`. */
  author = '';
  /** `dc:language` (BCP 47 tag such as `en`), or `''`. */
  language = '';
  /** @type {Map<string, Promise<string | null>>} Cache of blob: URLs keyed by ZIP path. */
  #resourceUrls = new Map();

  /**
   * Use {@link Book.open} instead; this only stores the archive.
   * @param {ZipArchive} zip      The book's archive.
   * @param {string} opfPath      ZIP path of the OPF package document.
   */
  constructor(zip, opfPath) {
    /** The book's archive. */
    this.zip = zip;
    /** ZIP path of the OPF package document; manifest hrefs are relative to it. */
    this.opfPath = opfPath;
  }

  /**
   * Unzips and parses an EPUB file.
   * @param {ArrayBuffer} buffer  Contents of the `.epub` file.
   * @returns {Promise<Book>}
   * @throws {EpubError | import('./zip.js').ZipError} If the file can't be read as an EPUB.
   */
  static async open(buffer) {
    const zip = new ZipArchive(buffer);
    await assertNotDrm(zip);

    if (!zip.has('META-INF/container.xml')) throw new EpubError('Not an EPUB: META-INF/container.xml is missing.');
    const container = parseXml(await zip.readText('META-INF/container.xml'));
    const rootfiles = byTag(container, 'rootfile');
    const rootfile =
      rootfiles.find((el) => (el.getAttribute('media-type') ?? '') === 'application/oebps-package+xml') ?? rootfiles[0];
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath || !zip.has(opfPath)) throw new EpubError('EPUB package document (OPF) not found.');

    const book = new Book(zip, opfPath);
    await book.#parsePackage(parseXml(await zip.readText(opfPath)));
    if (book.spine.length === 0) throw new EpubError('This EPUB has no readable content.');
    return book;
  }

  /**
   * Finds a document's position in the reading order (case-insensitive fallback).
   * @param {string} path  ZIP path of a content document.
   * @returns {number} Spine index, or -1 if the document isn't in the spine.
   */
  spineIndexOf(path) {
    const index = this.spine.findIndex((item) => item.path === path);
    if (index >= 0) return index;
    const lower = path.toLowerCase();
    return this.spine.findIndex((item) => item.path.toLowerCase() === lower);
  }

  /**
   * Loads a content document as a DOM. Prefers strict XHTML parsing and falls back
   * to the forgiving HTML parser (e.g. for files using HTML-only entities like &nbsp;,
   * or files missing the XHTML namespace).
   * @param {string} path  ZIP path of the document.
   * @returns {Promise<Document>} An inert document (scripts never run in DOMParser output).
   */
  async loadDocument(path) {
    const text = await this.zip.readText(path);
    const mediaType = this.#manifestByPath.get(path)?.mediaType ?? 'application/xhtml+xml';
    if (mediaType !== 'text/html') {
      try {
        const doc = parseXml(text, 'application/xhtml+xml');
        if (doc.documentElement.namespaceURI === XHTML_NS) return doc;
      } catch {
        // fall through to HTML parsing
      }
    }
    return new DOMParser().parseFromString(text, 'text/html');
  }

  /**
   * Returns a blob: URL for a file in the EPUB (e.g. an image), creating it on first use.
   * URLs stay valid until {@link Book#destroy} is called.
   * @param {string} path  ZIP path of the resource.
   * @returns {Promise<string | null>} The URL, or null if the file doesn't exist.
   */
  resourceUrl(path) {
    let url = this.#resourceUrls.get(path);
    if (!url) {
      url = this.#createResourceUrl(path);
      this.#resourceUrls.set(path, url);
    }
    return url;
  }

  /** Releases all blob: URLs created for this book. Call when the book is closed. */
  async destroy() {
    const urls = await Promise.all(this.#resourceUrls.values());
    for (const url of urls) if (url) URL.revokeObjectURL(url);
    this.#resourceUrls.clear();
  }

  /**
   * Extracts a resource and wraps it in a typed Blob URL.
   * @param {string} path
   * @returns {Promise<string | null>}
   */
  async #createResourceUrl(path) {
    if (!this.zip.has(path)) return null;
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const type = this.#manifestByPath.get(path)?.mediaType ?? MIME_BY_EXTENSION[extension] ?? '';
    const bytes = await this.zip.read(path);
    return URL.createObjectURL(new Blob([bytes], { type }));
  }

  /**
   * Reads metadata, manifest and spine from the OPF, then loads the table of contents.
   * Spine items whose files are missing from the ZIP are skipped. If no usable table
   * of contents exists, one entry per spine item is generated.
   * @param {Document} opf  The parsed package document.
   */
  async #parsePackage(opf) {
    const firstDc = (/** @type {string} */ name) =>
      opf.getElementsByTagNameNS(DC_NS, name)[0] ?? byTag(opf, name)[0];
    this.title = cleanText(firstDc('title')) || 'Untitled';
    this.author = cleanText(firstDc('creator'));
    this.language = cleanText(firstDc('language'));

    for (const el of byTag(opf, 'item')) {
      const id = el.getAttribute('id');
      const href = el.getAttribute('href');
      if (!id || !href) continue;
      /** @type {ManifestItem} */
      const item = {
        id,
        path: resolveHref(this.opfPath, href).path,
        mediaType: el.getAttribute('media-type') ?? '',
        properties: (el.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
      };
      this.manifest.set(id, item);
      this.#manifestByPath.set(item.path, item);
    }

    for (const el of byTag(opf, 'itemref')) {
      const item = this.manifest.get(el.getAttribute('idref') ?? '');
      if (!item || !this.zip.has(item.path)) continue;
      this.spine.push({ path: item.path, linear: el.getAttribute('linear') !== 'no' });
    }

    // A broken table of contents shouldn't stop the book from opening.
    try {
      const ncxId = byTag(opf, 'spine')[0]?.getAttribute('toc') ?? '';
      this.toc = (await this.#parseNav()) ?? (await this.#parseNcx(this.manifest.get(ncxId))) ?? [];
    } catch (error) {
      console.warn('Could not read table of contents', error);
    }
    if (this.toc.length === 0) {
      this.toc = this.spine.map((_, i) => ({ label: `Section ${i + 1}`, spineIndex: i, fragment: '', depth: 0 }));
    }
  }

  /**
   * Reads the EPUB 3 navigation document: the `<nav epub:type="toc">` (or first
   * `<nav>`) and its nested `<ol>/<li>` lists. List items without a link (e.g.
   * `<span>` part headings) are skipped, but their children are kept.
   * @returns {Promise<TocEntry[] | null>} Entries, or null if there's no usable nav document.
   */
  async #parseNav() {
    const navItem = [...this.manifest.values()].find((item) => item.properties.includes('nav'));
    if (!navItem || !this.zip.has(navItem.path)) return null;
    const doc = await this.loadDocument(navItem.path);
    const navs = byTag(doc, 'nav');
    // XML parsing exposes epub:type as a namespaced attribute; HTML parsing keeps the literal name.
    const isToc = (/** @type {Element} */ nav) =>
      (nav.getAttributeNS(OPS_NS, 'type') || nav.getAttribute('epub:type') || '').split(/\s+/).includes('toc');
    const nav = navs.find(isToc) ?? navs[0];
    const list = nav && byTag(nav, 'ol')[0];
    if (!list) return null;

    /** @type {TocEntry[]} */
    const entries = [];
    const walk = (/** @type {Element} */ ol, /** @type {number} */ depth) => {
      for (const li of childrenByTag(ol, 'li')) {
        const label = childrenByTag(li, 'a')[0] ?? childrenByTag(li, 'span')[0];
        const href = label?.getAttribute('href');
        if (label && href) this.#addTocEntry(entries, cleanText(label), resolveHref(navItem.path, href), depth);
        for (const child of childrenByTag(li, 'ol')) walk(child, depth + 1);
      }
    };
    walk(list, 0);
    return entries.length > 0 ? entries : null;
  }

  /**
   * Reads an EPUB 2 NCX table of contents (nested `navPoint` elements).
   * @param {ManifestItem | undefined} ncxItem  The item named by `<spine toc="…">`; if
   *   absent, the first manifest item with the NCX media type is used.
   * @returns {Promise<TocEntry[] | null>} Entries, or null if there's no usable NCX.
   */
  async #parseNcx(ncxItem) {
    ncxItem ??= [...this.manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml');
    if (!ncxItem || !this.zip.has(ncxItem.path)) return null;
    const ncx = parseXml(await this.zip.readText(ncxItem.path));
    const navMap = byTag(ncx, 'navMap')[0];
    if (!navMap) return null;

    /** @type {TocEntry[]} */
    const entries = [];
    const walk = (/** @type {Element} */ parent, /** @type {number} */ depth) => {
      for (const point of childrenByTag(parent, 'navPoint')) {
        const label = cleanText(byTag(point, 'navLabel')[0]);
        const src = childrenByTag(point, 'content')[0]?.getAttribute('src');
        if (src) this.#addTocEntry(entries, label, resolveHref(ncxItem.path, src), depth);
        walk(point, depth + 1);
      }
    };
    walk(navMap, 0);
    return entries.length > 0 ? entries : null;
  }

  /**
   * Appends a table-of-contents entry if its target is in the spine.
   * @param {TocEntry[]} entries                     List to append to.
   * @param {string} label                           Display text (a placeholder is used if empty).
   * @param {{ path: string, fragment: string }} target  Resolved link target.
   * @param {number} depth                           Nesting level.
   */
  #addTocEntry(entries, label, target, depth) {
    const spineIndex = this.spineIndexOf(target.path);
    if (spineIndex < 0) return;
    entries.push({ label: label || `Section ${spineIndex + 1}`, spineIndex, fragment: target.fragment, depth });
  }
}

/**
 * Rejects DRM-protected books. `META-INF/encryption.xml` may legitimately list
 * obfuscated fonts; any other encryption algorithm means the content is locked.
 * @param {ZipArchive} zip
 * @throws {EpubError} If the book uses DRM.
 */
async function assertNotDrm(zip) {
  if (!zip.has('META-INF/encryption.xml')) return;
  const doc = parseXml(await zip.readText('META-INF/encryption.xml'));
  const locked = byTag(doc, 'EncryptionMethod').some(
    (el) => !FONT_OBFUSCATION.has(el.getAttribute('Algorithm') ?? ''),
  );
  if (locked) throw new EpubError('This EPUB is DRM-protected and cannot be opened.');
}
