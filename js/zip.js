// @ts-check

/**
 * @file Minimal read-only ZIP reader.
 *
 * EPUB files are ZIP archives. This module reads the archive's central directory to
 * index every file, then extracts individual files on demand. Decompression uses the
 * browser's built-in `DecompressionStream('deflate-raw')`, so no library or WASM is
 * needed.
 *
 * Supported: "stored" (method 0) and "deflate" (method 8) entries, which are the only
 * methods EPUB allows. Not supported: ZIP64 and encrypted entries.
 *
 * ZIP layout, with the parts this module reads:
 *
 *     [local header][data] [local header][data] … [central directory] [EOCD]
 *                                                   ▲ index of entries  ▲ points to the index
 *
 * @see https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */

/**
 * One file in the archive, as described by its central directory record.
 * @typedef {object} ZipEntry
 * @property {string} name               Path inside the archive, e.g. `OEBPS/Text/ch1.xhtml`.
 * @property {number} flags              General-purpose bit flags (bit 0 = encrypted).
 * @property {number} method             Compression method: 0 = stored, 8 = deflate.
 * @property {number} compressedSize     Size of the stored bytes.
 * @property {number} size               Size after decompression.
 * @property {number} localHeaderOffset  Byte offset of the entry's local file header.
 */

/** Signature of the End Of Central Directory record (`PK\x05\x06`). */
const EOCD_SIG = 0x06054b50;
/** Signature of a central directory file header (`PK\x01\x02`). */
const CENTRAL_SIG = 0x02014b50;
/** Signature of a local file header (`PK\x03\x04`). */
const LOCAL_SIG = 0x04034b50;
/** Size of the EOCD record when it has no trailing comment. */
const EOCD_MIN_SIZE = 22;

/** Thrown when the archive is not a ZIP, is damaged, or uses unsupported features. */
export class ZipError extends Error {}

/**
 * An in-memory ZIP archive. The constructor indexes the entries; file contents are
 * only decompressed when {@link ZipArchive#read} is called.
 *
 * @example
 * const zip = new ZipArchive(await file.arrayBuffer());
 * const xml = await zip.readText('META-INF/container.xml');
 */
export class ZipArchive {
  /** @type {Map<string, ZipEntry>} Entries keyed by exact path. */
  #entries = new Map();
  /** @type {Map<string, ZipEntry>} Entries keyed by lower-cased path, for EPUBs whose links get the case wrong. */
  #entriesLower = new Map();
  /** @type {Uint8Array} The whole archive. */
  #bytes;
  /** @type {DataView} Little-endian view of the archive, used to read header fields. */
  #view;

  /**
   * Indexes an archive.
   * @param {ArrayBuffer} buffer  The complete contents of the ZIP file.
   * @throws {ZipError} If the data is not a readable ZIP archive.
   */
  constructor(buffer) {
    this.#bytes = new Uint8Array(buffer);
    this.#view = new DataView(buffer);
    this.#readCentralDirectory();
  }

  /**
   * Paths of every file in the archive (directories excluded).
   * @returns {string[]}
   */
  get names() {
    return [...this.#entries.keys()];
  }

  /**
   * Whether the archive contains a file. Falls back to a case-insensitive match.
   * @param {string} name  Path inside the archive.
   * @returns {boolean}
   */
  has(name) {
    return this.#find(name) !== undefined;
  }

  /**
   * Extracts a file's bytes, decompressing them if needed.
   * @param {string} name  Path inside the archive.
   * @returns {Promise<Uint8Array<ArrayBuffer>>} A fresh copy of the file's contents.
   * @throws {ZipError} If the file is missing, encrypted, damaged or uses an unsupported method.
   */
  async read(name) {
    const entry = this.#find(name);
    if (!entry) throw new ZipError(`Missing file in archive: ${name}`);
    if (entry.flags & 0x1) throw new ZipError(`Encrypted file in archive: ${name}`);

    // The local header's name/extra lengths can differ from the central directory's,
    // so they must be read here to find where the data starts.
    const view = this.#view;
    const at = entry.localHeaderOffset;
    if (at + 30 > view.byteLength || view.getUint32(at, true) !== LOCAL_SIG) {
      throw new ZipError(`Corrupt local header for ${name}`);
    }
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const data = this.#bytes.slice(start, start + entry.compressedSize);

    if (entry.method === 0) return data;
    if (entry.method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new ZipError(`Unsupported compression method ${entry.method} for ${name}`);
  }

  /**
   * Extracts a file and decodes it as UTF-8 text.
   * @param {string} name  Path inside the archive.
   * @returns {Promise<string>}
   */
  async readText(name) {
    // TextDecoder strips a UTF-8 BOM by default.
    return new TextDecoder().decode(await this.read(name));
  }

  /**
   * Looks up an entry by exact path, then case-insensitively.
   * @param {string} name
   * @returns {ZipEntry | undefined}
   */
  #find(name) {
    return this.#entries.get(name) ?? this.#entriesLower.get(name.toLowerCase());
  }

  /**
   * Finds the End Of Central Directory record and indexes every central directory entry.
   * @throws {ZipError}
   */
  #readCentralDirectory() {
    const view = this.#view;
    if (view.byteLength < EOCD_MIN_SIZE) throw new ZipError('File is too small to be an EPUB.');

    // The end-of-central-directory record sits at the end, followed by an optional comment (≤ 64 KiB).
    let eocd = -1;
    const stop = Math.max(0, view.byteLength - EOCD_MIN_SIZE - 0xffff);
    for (let i = view.byteLength - EOCD_MIN_SIZE; i >= stop; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('Not a valid EPUB (ZIP) file.');

    // EOCD: +10 total entry count (u16), +16 central directory offset (u32).
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || offset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');

    // Central directory header: fixed 46 bytes, then name, extra field and comment.
    const decoder = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIG) {
        throw new ZipError('Corrupt ZIP central directory.');
      }
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const name = decoder.decode(this.#bytes.subarray(offset + 46, offset + 46 + nameLength));

      /** @type {ZipEntry} */
      const entry = {
        name,
        flags: view.getUint16(offset + 8, true),
        method: view.getUint16(offset + 10, true),
        compressedSize: view.getUint32(offset + 20, true),
        size: view.getUint32(offset + 24, true),
        localHeaderOffset: view.getUint32(offset + 42, true),
      };
      if (!name.endsWith('/')) {
        this.#entries.set(name, entry);
        const lower = name.toLowerCase();
        if (!this.#entriesLower.has(lower)) this.#entriesLower.set(lower, entry);
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }
}
