// @ts-check

/**
 * @file Runs inside the reader frame, not the app's page: js/reader.js loads it from the
 * frame's template with a per-session CSP nonce. It hands Justif (vendor/justif/, MIT,
 * https://justif.lyall.co), which sets justified paragraphs with TeX-style line breaking
 * and hyphenation, to reader.js as `window.webreaderTypeset`.
 *
 * Justif has to run in the frame's own realm: it checks nodes with `instanceof Element`
 * and measures text with the global `document`, so calling it from the app's window
 * would fail. reader.js still decides what to justify and when.
 */

import { justify } from '../vendor/justif/index.js';

/**
 * Languages with hyphenation patterns in vendor/justif/hyphenate/, apart from English
 * (en-us and en-gb). Text in other languages is still justified, without hyphens.
 */
const PATTERN_LANGUAGES = new Set([
  'ca', 'da', 'de', 'el', 'es', 'fi', 'fr', 'hr', 'hu', 'it', 'nb', 'nl', 'nn', 'pl', 'pt', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk',
]);

/** @typedef {(word: string) => string[]} Hyphenator  Splits a lowercase word into hyphenatable fragments. */

/**
 * What this module puts on the frame's window for js/reader.js.
 * @typedef {object} Typesetter
 * @property {typeof justify} justify  Justif's `justify(elements, options)`.
 * @property {(language: string) => Promise<Hyphenator | undefined>} hyphenator
 *   The hyphenator for a BCP 47 language tag (e.g. "en", "fr-FR"), loaded on first
 *   use, or undefined if there are no patterns for that language.
 */

/** @type {Map<string, Promise<Hyphenator | undefined>>} Pattern file name → its loaded hyphenator. */
const loaded = new Map();

/**
 * The pattern file (without `.js`) for a language tag, following Justif's own rules:
 * English defaults to American, and Norwegian to Bokmål.
 * @param {string} language  BCP 47 tag; empty means English.
 * @returns {string | null}
 */
function patternFile(language) {
  const tag = language.trim().toLowerCase().replace(/_/g, '-');
  if (tag === '' || tag === 'en') return 'en-us';
  if (tag === 'en-gb' || tag.startsWith('en-gb-')) return 'en-gb';
  const base = tag.split('-')[0];
  if (base === 'en') return 'en-us';
  if (base === 'no') return 'nb';
  return PATTERN_LANGUAGES.has(base) ? base : null;
}

/** @type {Typesetter['hyphenator']} */
function hyphenator(language) {
  const file = patternFile(language);
  if (!file) return Promise.resolve(undefined);
  let hyphenate = loaded.get(file);
  if (!hyphenate) {
    // Each pattern module exports a single hyphenate function.
    hyphenate = import(`../vendor/justif/hyphenate/${file}.js`).then(
      (module) => /** @type {Hyphenator} */ (Object.values(module)[0]),
      (error) => {
        console.warn(`Hyphenation patterns for "${language}" failed to load:`, error);
        return undefined;
      },
    );
    loaded.set(file, hyphenate);
  }
  return hyphenate;
}

/** @type {Typesetter} */
const typesetter = Object.freeze({ justify, hyphenator });
Object.defineProperty(window, 'webreaderTypeset', { value: typesetter });
