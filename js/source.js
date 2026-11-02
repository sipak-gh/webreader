// @ts-check

/**
 * @file Loading books from a `?source=` URL parameter, so a link can open the
 * reader with a specific book.
 *
 * The value can be a URL (ideally percent-encoded with encodeURIComponent) or the URL
 * encoded as base64 / base64url:
 *
 *     ?source=https%3A%2F%2Fexample.com%2Fbook.epub
 *     ?source=aHR0cHM6Ly9leGFtcGxlLmNvbS9ib29rLmVwdWI
 *
 * The file is fetched by the browser, so the host must allow cross-origin requests
 * (send `Access-Control-Allow-Origin`).
 */

/** Name of the query parameter that holds the book link. */
export const SOURCE_PARAM = 'source';

/** Thrown for an invalid `source` value or a failed download. The message is shown to the user. */
export class SourceError extends Error {}

/**
 * Parses text as an absolute http(s) URL.
 * @param {string} text
 * @returns {URL | null} Null if the text isn't an http(s) URL.
 */
function asHttpUrl(text) {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * Decodes standard or URL-safe base64 (padding optional) into UTF-8 text.
 * @param {string} value
 * @returns {string}
 * @throws {Error} If the value isn't valid base64 or the bytes aren't valid UTF-8.
 */
function decodeBase64(value) {
  // URLSearchParams turns "+" into a space, so undo that before decoding.
  let b64 = value.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Rewrites github.com "raw"/"blob" links to raw.githubusercontent.com. The github.com
 * redirect has no CORS headers, so browsers cannot fetch it directly.
 *
 * @example
 * normalizeSourceUrl(new URL('https://github.com/user/repo/raw/refs/heads/master/book.epub'))
 * // → https://raw.githubusercontent.com/user/repo/refs/heads/master/book.epub
 *
 * @param {URL} url
 * @returns {URL} The rewritten URL, or `url` unchanged.
 */
export function normalizeSourceUrl(url) {
  if (url.hostname === 'github.com') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/);
    if (match) return new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`);
  }
  return url;
}

/**
 * Parses the `source` parameter value: a plain URL first, then base64.
 * @param {string} value  The parameter value, as returned by {@link getSourceParam}.
 * @returns {URL} The (normalised) URL to download.
 * @throws {SourceError} If the value is neither form of an http(s) URL.
 */
export function parseSource(value) {
  const trimmed = value.trim();
  let url = asHttpUrl(trimmed);
  if (!url) {
    try {
      url = asHttpUrl(decodeBase64(trimmed).trim());
    } catch {
      url = null;
    }
  }
  if (!url) throw new SourceError('The "source" link is not a valid http(s) URL.');
  return normalizeSourceUrl(url);
}

/**
 * Reads the `source` parameter from the page's address.
 * @returns {string | null} The decoded value, or null if absent.
 */
export function getSourceParam() {
  return new URLSearchParams(location.search).get(SOURCE_PARAM);
}

/**
 * Puts a book link in the address bar as `?source=` (keeping other parameters)
 * without reloading, so a reload reopens it and the address can be shared.
 * @param {URL} url  The book's URL.
 */
export function setSourceParam(url) {
  const page = new URL(location.href);
  page.searchParams.set(SOURCE_PARAM, url.href);
  history.replaceState(history.state, '', page);
}

/**
 * Removes `source` from the address bar (keeping other parameters) without
 * reloading. Used when the user opens a local file, so a reload doesn't switch back
 * to the linked book.
 */
export function clearSourceParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has(SOURCE_PARAM)) return;
  url.searchParams.delete(SOURCE_PARAM);
  history.replaceState(history.state, '', url);
}

/**
 * A display name for a downloaded file: the last path segment, decoded.
 * @param {URL} url
 * @returns {string} The file name, or the host name if the path is empty.
 */
export function fileNameFromUrl(url) {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last) || url.hostname;
  } catch {
    return last || url.hostname;
  }
}

/**
 * Downloads a file without cookies, reporting progress as it streams in.
 * @param {URL} url
 * @param {(fraction: number | null) => void} [onProgress]  Called per chunk with 0–1,
 *   or null if the server didn't send a Content-Length.
 * @returns {Promise<ArrayBuffer>} The file's contents.
 * @throws {SourceError} On network/CORS failure or a non-2xx response.
 */
export async function download(url, onProgress) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    throw new SourceError(
      `Could not download ${url.hostname}${url.pathname}. You may be offline, or the server doesn't allow other sites to download its files (CORS).`,
    );
  }
  if (!response.ok) throw new SourceError(`Download failed (HTTP ${response.status}).`);

  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(total > 0 ? Math.min(1, received / total) : null);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
