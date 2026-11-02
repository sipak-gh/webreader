import { H as HangingPunctuationMode, k as ProtrusionTable, E as ExpansionOptions, T as TrackingOptions } from './protrusion-fonts-CFYliB0d.js';
export { d as Line, n as composeProtrusion, q as fontProtrusion, s as hangingCharacters, t as hangingPunctuation, u as kinsokuNotAtLineEnd, v as kinsokuNotAtLineStart, w as latinProtrusion } from './protrusion-fonts-CFYliB0d.js';

/**
 * The public option surface, and what it resolves to.
 *
 * Two audiences meet here. Outward, this is the documented API — every knob a
 * caller can turn, with the typographic reasoning behind its default, because
 * a justification setting whose consequence is not explained is a setting
 * nobody can choose between. Inward, `resolveOptions` turns that into the
 * flat, fully-defaulted shape the layout actually runs on, once per
 * controller.
 *
 * Pure by construction: nothing here touches the DOM, so what a controller
 * will do with a given option object can be worked out without a document.
 *
 * The split between the public defaults and the CORE defaults in
 * ./core/types.js is deliberate and shows up repeatedly below. The core is
 * classic TeX; the public API is Bringhurst. `lastLineMinWidth` and
 * `tracking` are both core-off, public-on for that reason.
 */

interface JustifyOptions {
    /** Word splitter, e.g. `hyphenateEnUS` from "justif/hyphenate/en-us".
     * Never called for RTL paragraphs (Arabic joining makes fragment
     * measurement invalid; Hebrew convention breaks without hyphens). */
    hyphenate?: (word: string) => readonly string[];
    tolerance?: number;
    pretolerance?: number;
    hyphenPenalty?: number;
    exHyphenPenalty?: number;
    linePenalty?: number;
    adjDemerits?: number;
    doubleHyphenDemerits?: number;
    finalHyphenDemerits?: number;
    emergencyStretch?: number | "auto";
    /**
     * Keep paragraph endings and lines terminated by `<br>` at least this
     * fraction of the measure wide (0.33 ≈ Bringhurst's "at least a third").
     * Two mechanisms compose.
     * The breaker prefers arrangements whose endings reach the threshold
     * naturally — cost pressure that escalates into hyphenation when
     * needed, and prices endings by exactly what will render, so it steers
     * into arrangements the render floor can finish. An ending that still
     * falls short is then RENDERED with its word spaces widened to the
     * threshold — within a willingness that scales with the setting:
     * rectangles (`1`) work the spaces up to TeX's underfull-reporting
     * standard (≈ 2× natural at the default `spacing`), a gentle `0.33`
     * floor barely opens them. An ending that would need more keeps fully
     * natural spacing instead: all or nothing, never stretched AND still
     * short. The same principle holds for the whole paragraph: a threshold
     * ending is never bought with a worse-than-tolerance body line, and the
     * option never renders a shorter ending than it would produce switched
     * off (the breaker compares and keeps the better solution). The top of
     * the range can still be non-monotone per paragraph — one may satisfy
     * `0.5` yet revert to its natural ending at `1`. At `1` every paragraph
     * that can afford it sets as a perfect rectangle, including a one-line
     * paragraph. Values below `1` apply only to multi-line paragraphs: a
     * naturally one-line element stays in native layout because it has no
     * short ending to repair. Defaults to `0.33` (Bringhurst); pass `0` to
     * disable.
     */
    lastLineMinWidth?: number;
    /**
     * Character protrusion model. `true` (the default) measures each font's
     * glyph-specific optical alignment by rasterizing its glyphs. `false`
     * disables character protrusion — and only that: `hangingPunctuation` is an
     * independent setting, so `false` with hanging left on sets ordinary glyphs
     * exactly flush while the eligible marks still hang.
     *
     * An object selects the fixed table-backed model and supplies
     * per-character overrides, in thousandths of the character's own advance.
     * Overrides are merged over the generic Latin table and any matching
     * hand-tuned per-font table. Values cap at 1000 — a whole advance is as far
     * out as a glyph goes — while negatives are honoured and pull it inward. A
     * value here sets how far a character protrudes and never makes it hang;
     * membership is `hangingPunctuation`'s to decide.
     *
     * Built-in tables (the generic Latin list plus microtype's per-font configs)
     * remain as the FALLBACK, used per font wherever the measurement cannot run
     * — a canvas that will not rasterize or read back, or one the browser will
     * not shape a run's font-variant in — and for the characters the raster pass
     * has no candidate for, such as the Arabic and Hebrew stops. They are not
     * separately selected when `true`; passing an object (including `{}`)
     * bypasses measurement and uses them directly.
     */
    protrusion?: boolean | ProtrusionTable;
    /**
     * Full-hanging policy, independent of `protrusion`. `"line-end-only"` (the
     * default) fully hangs eligible punctuation at line ends while line starts
     * retain optical alignment. `"first-line-and-line-ends"` adds the CSS `first`
     * model on top of that: the paragraph's opening quote hangs fully and later
     * line starts set those marks flush. `"all-line-edges"` fully hangs at every
     * line edge; `"none"` applies only the selected protrusion model.
     *
     * Hanging is composed as a protrusion overlay, but the two settings switch
     * separately: with `protrusion: false` the overlay composes over an empty
     * base, and with `"none"` the protrusion model applies alone.
     *
     * An object additionally chooses WHICH characters are marginal — see
     * `HangingPunctuationOptions`.
     *
     * Compatibility: `true` selects the default; `false` selects `"none"`;
     * `"first-line"` aliases `"first-line-and-line-ends"`; and `"all-lines"`
     * aliases `"all-line-edges"`.
     */
    hangingPunctuation?: true | HangingPunctuationMode | HangingPunctuationOptions;
    /** Glyph expansion limits via the wdth axis; false disables. Fields left out
     * take their default, like `spacing` and `tracking`. */
    expansion?: Partial<ExpansionOptions> | false;
    /**
     * Inter-word glue flexibility as fractions of the space width. `pull`
     * (0–1, default 0.7) is the downward pressure on secondary-font spaces
     * wider than the paragraph base font's: 0 keeps each font's natural
     * space, 1 converges them fully to the base (risks dissolving word
     * boundaries in loose-fitting fonts like monospace). `boundaryShrink`
     * (0–1, default 0) multiplies the shrink of spaces at font-FAMILY
     * boundaries: chips and pills (inline code, <kbd>) live there, their
     * insets occupy part of the adjacent gap, and native CSS justification
     * never shrinks a space — so by default those gaps stretch but hold
     * their natural width. 1 restores TeX semantics.
     */
    spacing?: Partial<{
        stretch: number;
        shrink: number;
        pull: number;
        boundaryShrink: number;
    }>;
    /**
     * Letterfit tracking: lets inter-character space open or close each
     * line's set width, participating in break decisions like expansion.
     * `true` (the DEFAULT) allows ±3% — Bringhurst's tolerance for
     * letterspacing variation in justified text (The Elements of Typographic
     * Style); `false` disables. Word space and glyph expansion remain the
     * primary flexes (tracking saturates at its budget), and the last line
     * always keeps its natural letterfit. Beyond TeX: microtype's
     * letterspacing is static styling, never a per-line justification
     * variable. Always off for RTL paragraphs (letterspacing cursive Arabic
     * is typographically wrong and renders inconsistently across engines).
     */
    tracking?: boolean | Partial<TrackingOptions>;
    /**
     * Last-line color matching (eTeX's \lastlinefit): the paragraph ending's
     * spaces are set at this fraction (0–1) of the paragraph's average
     * looseness, instead of always natural width — a connoisseur's
     * refinement mainstream DTP tools only approximate with a static
     * "desired spacing" value. Lines terminated by `<br>` contribute their
     * justified body lines to the average but do not receive last-line fitting
     * themselves. 0 (default) = off.
     */
    lastLineFit?: number;
    /**
     * Clean library-introduced characters out of copied text (default true).
     * Wrap determinism renders mid-line run-boundary spaces as NBSP and rare
     * dash junctions carry a U+2060 word joiner — plumbing that shouldn't
     * survive into the clipboard. Word joiners are always removed; NBSPs are
     * normalized back to spaces only when the selection's paragraphs
     * contained no author NBSPs (author intent like `Fig.&nbsp;7` wins over
     * cleanup). `false` restores raw copies.
     */
    cleanClipboard?: boolean;
    /**
     * Re-layout managed paragraphs when their content width changes
     * (default true). With `false`, width changes after enhancement are
     * not tracked — including ones caused by OTHER elements' late-loading
     * fonts resizing a shared shrink-to-fit container; call `refresh()`
     * after such changes.
     */
    observeResize?: boolean;
    /**
     * Called after a paragraph's rendered layout changes — initial
     * enhancement, resize re-layout, promotion from a native one-line state,
     * restoration when it fits on one line again, refresh, and re-measures
     * triggered by fonts finishing to load. Use it to keep overlays or
     * annotations positioned over the text in sync. NOT fired for the deferred
     * wrap-guarantee corrections: those reconcile sub-pixel painted-edge drift
     * with small spacing changes but do not alter chosen breaks or paragraph
     * structure.
     */
    onRelayout?: (paragraph: HTMLElement) => void;
    /**
     * Called once per paragraph that justif declines to manage, with a short
     * human-readable reason ("inline <kbd> has a horizontal margin",
     * "font-variation-settings on a run", "threw while rendering: …").
     * Declines are otherwise silent by design — the paragraph keeps its
     * native CSS rendering — which makes "skipped" indistinguishable from
     * "broken" while integrating; this is the diagnosis channel.
     */
    onSkip?: (paragraph: HTMLElement, reason: string) => void;
}
/**
 * Hanging punctuation as its two independent parts: which characters are
 * marginal, and where that classification applies.
 *
 * Membership carries no depth. A character is either outside the measure or
 * it is not — how far a mark sits from the margin when it is NOT hung is the
 * `protrusion` model's business, and writing a depth here would merge two
 * features that answer different questions.
 */
interface HangingPunctuationOptions {
    /** Which line edges the classification applies to, and on which lines.
     * Defaults to the same policy the string form selects. */
    edges?: HangingPunctuationMode;
    /**
     * Which characters are marginal. Each side REPLACES the built-in set for
     * that side; a side left out keeps its default, so naming one edge never
     * silently empties the other. Compose from the exported `hangingCharacters`
     * to extend rather than replace:
     *
     * ```js
     * characters: { start: hangingCharacters.start + "([{" }   // + CSS brackets
     * characters: { end: "" }                                  // starts only
     * ```
     *
     * Replacing `end` wholesale drops the CJK stops that make burasage work, so
     * mixed Japanese and Latin text wants `hangingCharacters.end + "…"` rather
     * than a bare list. Nothing is validated: a letter here will hang.
     */
    characters?: {
        start?: string;
        end?: string;
    };
}
/**
 * The layout settings a live reconfiguration can replace. Everything else a
 * controller was built with — the hyphenator, callbacks, breaker penalties,
 * clipboard cleanup, resize observation — is fixed for its lifetime.
 */
type LayoutOptions = Pick<JustifyOptions, "hangingPunctuation" | "protrusion" | "expansion" | "tracking" | "spacing" | "lastLineMinWidth" | "lastLineFit">;
/**
 * What each `LayoutOptions` field resolves to when omitted. Exported so callers
 * can tell "the author asked for the default" apart from "the author asked for
 * something that happens to equal it" — the drop-in needs exactly that to avoid
 * splitting paragraphs into separate controllers over identical settings — and
 * so configuration UI has one source for its initial values.
 *
 * Declared after the constants it reads: a `const` is not initialized until its
 * own statement runs, so hoisting this above them would throw at module load.
 */
declare const layoutDefaults: Readonly<{
    hangingPunctuation: "line-end-only";
    protrusion: true;
    expansion: ExpansionOptions;
    tracking: TrackingOptions;
    spacing: {
        stretch: number;
        shrink: number;
        pull: number;
        boundaryShrink: number;
    };
    lastLineMinWidth: 0.33;
    lastLineFit: 0;
}>;

/**
 * justif — text justification for perfectionists.
 *
 * `justify(document.querySelectorAll("p"))` re-lays-out existing paragraphs
 * with Knuth-Plass optimal line breaking, character protrusion (optical
 * margin alignment, per-font via measured glyph geometry), font expansion
 * on variable fonts with a wdth axis, and optional letterfit tracking
 * (Bringhurst's ±3%). Resize re-runs arithmetic only; `destroy()` restores
 * the original DOM.
 */

interface JustifyController {
    /**
     * Resolves once the content's font faces have settled (loaded or
     * failed) and the layout converged on them. The text is enhanced
     * earlier than this — justify() commits synchronously against
     * whatever fonts are rendering at call time, so a still-loading
     * webfont shows its fallback justified until the faces settle.
     */
    readonly ready: Promise<void>;
    /**
     * Re-measure with the currently loaded font files and re-layout (also runs
     * automatically when webfonts finish loading). The original scan is reused, so
     * CSS changes need `rescan()` and content changes a fresh controller.
     */
    refresh(): void;
    /**
     * Re-read author CSS and re-enhance wherever it now reads differently: what to
     * call after changing the styling of managed paragraphs — `hyphens`, the font,
     * `letter-spacing`, `white-space`, `line-height`, `text-indent` — from a
     * stylesheet, a class, a theme toggle, or the devtools inspector.
     *
     * Returns the paragraphs it re-read. Ones whose styling is unchanged are left
     * strictly alone, so calling this on every suspicion is cheap: the check is one
     * computed-style read each. Paragraphs previously DECLINED are retried on the
     * same terms, since a style change is exactly what can make one eligible.
     *
     * `targets` narrows the work to some of this controller's paragraphs; omitted,
     * it considers all of them. Paragraphs released by `unjustify()` stay released.
     *
     * A re-read paragraph is restored to its author DOM and enhanced again, so —
     * unlike `refresh()` — a selection or caret inside one does not survive. Text
     * `content` changes are still out of scope: what gets re-read is the CSS.
     */
    rescan(targets?: Iterable<Element>): readonly HTMLElement[];
    /**
     * Replace this controller's layout settings and re-lay out its paragraphs,
     * reusing the existing scan. Cheaper than `destroy()` + `justify()`, and it
     * keeps observers, clipboard registration, and paragraph identity.
     *
     * `config` is COMPLETE, not a patch: a field left out takes the library
     * default, which is how a caller restores one. Anything outside
     * `LayoutOptions` is untouched — notably `hyphenate` (with its memoized
     * cache), `onSkip`, and `onRelayout`. `cleanClipboard` and `observeResize`
     * are deliberately not reconfigurable: the first registers a shared copy
     * handler once, and the second attaches observers once, so changing either
     * needs a fresh controller.
     */
    applyLayoutOptions(config: LayoutOptions): void;
    /** Restore the original DOM and disconnect observers. */
    destroy(): void;
    readonly paragraphs: readonly HTMLElement[];
    /**
     * The subset of `paragraphs` this controller still manages. Absent are ones
     * it declined, ones released by `destroy()` or `unjustify()`, and ones whose
     * enhancement was removed from the DOM from outside.
     *
     * Paragraphs sitting in native one-line layout ARE managed: they carry no
     * `data-justif` attribute, but the controller still holds their measurements
     * and watches for a measure narrow enough to make line breaking useful. Test
     * this rather than the attribute to ask "is this enhancement still live?".
     *
     * The attribute answers the OTHER question, "is justif's rendering on the
     * page right now?": every enhancement sets `data-justif` and every restore
     * removes it, so a managed paragraph without the attribute is one the
     * controller is watching but currently renders natively — a paragraph
     * short enough for one line, or one whose leading float leaves no room to
     * set beside it. Both signals are supported; they are two questions.
     */
    readonly managed: readonly HTMLElement[];
}
declare function justify(targets: Element | Iterable<Element>, options?: JustifyOptions): JustifyController;
/** Restore paragraphs enhanced by any controller to their original DOM. */
declare function unjustify(targets: Element | Iterable<Element>): void;

export { ExpansionOptions, HangingPunctuationMode, type HangingPunctuationOptions, type JustifyController, type JustifyOptions, type LayoutOptions, ProtrusionTable, TrackingOptions, justify, layoutDefaults, unjustify };
