/**
 * Core data model. Everything here is DOM-free: widths are px floats already
 * resolved by the measurement layer (or a test mock).
 */
interface GlueSpec {
    width: number;
    stretch: number;
    shrink: number;
}
/**
 * One styling context inside a paragraph (the paragraph itself, an <em>, a
 * size change…). The measurement layer resolves fonts to these metrics; the
 * core never sees font names.
 */
interface RunMetrics {
    /** Opaque cache key (family+weight+style+size+spacing). */
    fontKey: string;
    /** Inter-word glue for this run, derived from the measured space width. */
    space: GlueSpec;
    /** Advance of the hyphen glyph in this run. */
    hyphenWidth: number;
    /**
     * Measured width multipliers at the expansion endpoints: the ratio of a
     * calibration string's width at font-stretch (100 + 100·max)% and
     * (100 − 100·shrink)% to its width at 100%. 1 means the font does not
     * respond on that side (no usable wdth axis) and expansion is disabled for
     * boxes of this run in that direction.
     */
    ratioAtMax: number;
    ratioAtMin: number;
    /**
     * Measured width multipliers at each quantized font-stretch percent the
     * layout can emit (keys = percent values, e.g. 101.5). When present, the
     * per-line expansion gain uses these measurements instead of linear
     * interpolation between the endpoints.
     */
    expansionRatios?: ReadonlyMap<number, number>;
    /**
     * Suppress hyphenation inside this run (CSS `hyphens: none`, e.g. inline
     * code): the hyphenator is never called and soft hyphens are stripped
     * rather than honored. Breaks at explicit hyphens remain (browsers break
     * there regardless of the hyphens property).
     */
    noHyphens?: boolean;
    /**
     * Clamp protrusion so a glyph's ink stops at the margin instead of hanging
     * past it. Set for monospace runs: protrusion codes are advance-relative
     * and assume proportional side bearings, but monospace glyphs sit in wide
     * uniform cells, so the code-implied hang would push the ink visibly out
     * of the measure. The clamp needs `Measure.inkBearings`.
     */
    protrudeInkOnly?: boolean;
    /**
     * Case mapping this run RENDERS under (CSS `text-transform`); absent when
     * it renders its source text. Box text stays source text throughout — only
     * per-character glyph identity needs this, because protrusion codes
     * describe glyphs and `A` and `a` carry different ones. Widths never do:
     * the measurer already probes with the property applied.
     *
     * Only the two context-free mappings appear here. `capitalize` depends on
     * where a word starts, which a per-character lookup cannot answer.
     */
    textTransform?: "uppercase" | "lowercase";
    /**
     * Hand-tuned protrusion table matched to this run's font (microtype's
     * per-font configs). Overrides BuildOptions.protrusion for this run;
     * absent → the paragraph-wide table applies.
     */
    protrusion?: ProtrusionTable;
    /** First-line variant of `protrusion` (see BuildOptions.protrusionFirst). */
    protrusionFirst?: ProtrusionTable;
    /** Per-run variant of `BuildOptions.protrusionCredit`. */
    protrusionCredit?: ProtrusionTable;
    /**
     * Identity of this run's font family (stack), independent of style,
     * weight, and size. Word spaces BETWEEN runs of different families lose
     * their shrink (see BuildOptions.boundaryShrink): such boundaries are
     * where chips and pills live, and a shrunken gap there reads as the chip
     * fusing with its neighbors. Absent → boundaries are never detected.
     */
    familyKey?: string;
}
/** Fixed inline-boundary advance and the portion allowed outside the measure.
 * Both values are in px; neither participates in glyph expansion. */
interface InlineEdge {
    advancePx: number;
    protrusionPx: number;
}
/** A piece of paragraph text in one run, in document order. */
interface RunText {
    text: string;
    run: number;
    /**
     * UTF-16 range whose characters are rendered by a floated
     * `::first-letter` box and therefore contribute no width to the normal
     * inline flow. The box text is retained for DOM reconstruction; item
     * widths, expansion, and tracking are measured from the remaining text.
     */
    flowExclusion?: {
        start: number;
        end: number;
    };
    /** Shorthand for suppressing character protrusion at both sides of every
     * Box produced by this piece (kept for headless callers). */
    paintedBox?: boolean;
    /** Side-specific forms of `paintedBox`. DOM scans use the fixed actual-edge
     * markers below instead, so internal slices retain glyph protrusion. */
    paintedStart?: boolean;
    paintedEnd?: boolean;
    /** Fixed line-start protrusion for a painted inline box, normally the
     * distance from its border edge through its inline-start padding to the
     * text. Unlike character codes, this value is already in px. */
    boxStartProtrusionPx?: number;
    /** Fixed line-end counterpart of `boxStartProtrusionPx`. Defined as 0
     * too: presence marks the actual final box of an unpadded painted inline. */
    boxEndProtrusionPx?: number;
    /**
     * Inline padding+border px preceding this piece's first box / following
     * its last box (an inline element's side extras, resolved by the reader).
     * Folded into the adjacent box's width: the extras are layout width that
     * travels with the element's first/last fragment — CSS
     * `box-decoration-break: slice` semantics, which is also how the DOM
     * writer's whole-element clones fragment across lines.
     */
    padStartPx?: number;
    padEndPx?: number;
    /** Resolved boundaries, replacing the corresponding padding and fixed
     * protrusion fields above. A zero protrusion still marks a real edge,
     * suppressing character hanging there without affecting internal slices. */
    startEdge?: InlineEdge;
    endEdge?: InlineEdge;
    /**
     * Set when this piece lives inside a `white-space: nowrap` inline
     * element: no break opportunity may be created between two boxes that
     * share a key (spaces stay justification-flexible, they just cannot
     * break). Distinct elements get distinct keys, so the space BETWEEN two
     * adjacent nowrap chips remains breakable.
     */
    atomicKey?: number;
    /**
     * This piece is an ATOMIC BOX — an inline-level object the model places
     * but never looks inside (an equation, an inline-block chip): a rigid
     * advance of `widthPx` with no text of its own. `text` is empty, and the
     * box it produces takes no protrusion, no expansion and no letterfit,
     * because none of them can move an object the model cannot reshape.
     */
    atomic?: {
        widthPx: number;
    };
}
declare const ItemType: {
    readonly Box: 0;
    readonly Glue: 1;
    readonly Penalty: 2;
};
type ItemType = (typeof ItemType)[keyof typeof ItemType];
interface Box {
    type: typeof ItemType.Box;
    /** Natural advance of `text` at font-stretch 100%, measured whole. */
    width: number;
    run: number;
    text: string;
    /** Number of rendered characters that remain in normal inline flow.
     * Absent when every character in `text` participates normally. */
    flowChars?: number;
    /** UTF-16 source range rendered by a floated `::first-letter` rather
     * than by the normal-flow nowrap segment. */
    flowExclusion?: {
        start: number;
        end: number;
    };
    /** Protrusion credit (px) if this box starts a line after the first. */
    lp: number;
    /** Protrusion credit (px) if this box starts the paragraph's FIRST line
     * (differs from lp only under hanging "first-line-and-line-ends"). */
    lpFirst: number;
    /** Protrusion credit (px) if this box ends a line. */
    rp: number;
    /** Stretch/shrink belonging to collapsible spaces included in a trailing
     * whitespace run. Excluded only when this box actually ends the line.
     * Always written (zero for the overwhelming majority of boxes) so the whole
     * box stream keeps one hidden class: the breaker reads both at every
     * breakpoint, and an absent field there costs more than the field does. */
    hangStretch: number;
    hangShrink: number;
    /** This is the actual final box of a fixed inline boundary. Renderers use the
     * marker (independent of rp, which may legitimately be zero) to keep
     * wrap-safety margins outside the decoration instead of pinching it. */
    paintedEnd?: boolean;
    /** Extra stretch/shrink available from font expansion (px). */
    expStretch: number;
    expShrink: number;
    /** Extra stretch/shrink available from letterfit tracking (px); folded
     * into the glue sums because tracking flexes continuously with the same
     * ratio as glue. Rendered as per-segment letter-spacing. */
    trackStretch: number;
    trackShrink: number;
    /** A fixed-width CSS "other space separator" emitted as its own box. It
     * remains real source text rather than becoming inter-word glue. If a
     * following penalty is chosen, the renderer already owns the character at
     * the end of this box and must emit a zero-width joint rather than inserting
     * an ordinary space. */
    otherSpace?: boolean;
    /** Fixed inline-boundary px folded into `width` (RunText extras). The
     * glyph run's own advance is width − padPx: expansion gain must scale
     * only the glyphs, never the box decorations. */
    padPx?: number;
    /** An atomic object box (RunText.atomic): rigid width, empty text. It
     * occupies flow like any box, but renderers must emit the object rather
     * than text for it, and nothing that reshapes glyphs may touch it. */
    atomic?: true;
}
interface Glue {
    type: typeof ItemType.Glue;
    width: number;
    stretch: number;
    /** Infinite-order stretch; only the final parfillskip glue uses this. */
    stretchFil: number;
    shrink: number;
    run: number;
    /**
     * CJK inter-character glue: no source space exists here. Renderers must
     * not emit a space character for it — its flex renders as inter-character
     * spacing (letter-spacing) instead of word-spacing. Never breakable on
     * its own (buildItems
     * always puts a penalty in front of it, so the glue-after-box rule never
     * fires).
     */
    cjk?: boolean;
    /**
     * A word space at a font-family boundary whose shrink was reduced (see
     * BuildOptions.boundaryShrink). Renderers must give it its OWN
     * word-spacing: it shares a run — and would otherwise share a rendered
     * segment — with fully shrinkable interior spaces.
     */
    rigid?: boolean;
    /** This collapsible space is immediately followed by a fixed-width space.
     * If that separator run ends the line, CSS hangs this glue with it. */
    fixedSpaceInitial?: boolean;
}
interface Penalty {
    type: typeof ItemType.Penalty;
    /** −INF_PENALTY … +INF_PENALTY. */
    penalty: number;
    /** Width added to the line if broken here (the hyphen glyph). */
    width: number;
    /** True for hyphen-ish breaks; consecutive flagged lines incur demerits. */
    flagged: boolean;
    /** True only for breaks inserted by the hyphenator (masked in pass 1). */
    hyphen: boolean;
    /** Protrusion credit of the materialized hyphen if the line ends here. */
    rp: number;
    run: number;
    /**
     * CJK inter-character break: the break site has NO source space, so a
     * line broken here must render a bare zero-width joint, never a space. This is
     * what distinguishes it from other unflagged zero-width penalties (from
     * hand-built withSums streams), which sit at real spaces and must keep
     * rendering the space they consumed.
     */
    cjk?: boolean;
    /** Soft-wrap boundary after a complete fixed-width separator run. */
    fixedSpace?: boolean;
    /** Break at an atomic object's junction (see ATOMIC_BREAK_PENALTY). Like
     * the CJK breaks, the site has NO source space, so a line broken here must
     * render a zero-width joint rather than the space a hand-built penalty in
     * front of a glue stands for. */
    atomic?: boolean;
}
type Item = Box | Glue | Penalty;
/** Protrusion codes in thousandths of the glyph's own advance (pdfTeX).
 * `l`/`r` are LOGICAL line-start/line-end sides: the renderer maps them to
 * physical margins via inline-start/end, so in an RTL paragraph an `l`
 * code hangs at the right edge and an `r` code at the left. */
interface ProtrusionCodes {
    l?: number;
    r?: number;
}
type ProtrusionTable = Readonly<Record<string, ProtrusionCodes>>;
interface ExpansionOptions {
    /** Max glyph stretch as a fraction (0.02 → font-stretch up to 102%). */
    max: number;
    /** Max glyph shrink as a fraction (0.02 → down to 98%). */
    shrink: number;
    /** Quantization step as a fraction (0.005 → 0.5% increments). */
    step: number;
}
interface BuildOptions {
    /** Splits a lowercase word into syllable pieces. Soft hyphens always win. */
    hyphenate?: (word: string) => readonly string[];
    hyphenPenalty: number;
    /** Penalty for breaking after an explicit "-" already in the text. */
    exHyphenPenalty: number;
    protrusion: ProtrusionTable | false;
    /** Table for boxes starting the paragraph's FIRST line (full hanging
     * punctuation on opening quotes). undefined → same as `protrusion`. */
    protrusionFirst?: ProtrusionTable;
    /** The protrusion model WITHOUT the hang overlay, used for the one glyph a
     * fully hung mark leaves at the line's start: it takes an ordinary optical
     * depth, never a second full hang. undefined → that glyph is credited
     * nothing. */
    protrusionCredit?: ProtrusionTable;
    expansion: ExpansionOptions | false;
    /** Letterfit tracking: inter-character space may open/close each line's
     * set width by these fractions (Bringhurst's tolerance is 0.03). Off by
     * default — word space and expansion are the primary flexes; TeX has no
     * equivalent (its letterspacing is static styling, not a per-line,
     * break-participating variable). */
    tracking: TrackingOptions | false;
    /**
     * eTeX-style \lastlinefit, layout-only: the last line's spaces are set
     * at this fraction of the paragraph's average adjustment ratio, so a
     * loose (or tight) paragraph doesn't end on a jarringly natural-width
     * line. 0 (default) = classic TeX, last line at natural width; 1 = the
     * ending fully adopts the paragraph's color. Capped at a fully
     * justified ending; the last line's letterfit stays natural.
     */
    lastLineFit: number;
    /**
     * Rendering floor for the paragraph ending, as a fraction of the
     * measure: a last line shorter than this stretches its word glue up to
     * the threshold (letterfit stays natural, as with `lastLineFit`) — but
     * only when the threshold is reachable within maxEndingStretch(v), the
     * v-scaled underfull bound. An ending that cannot reach it reverts to
     * natural spacing entirely: all or nothing, never stretched AND still
     * short. 1 sets every paragraph as a rectangle. Set
     * `BreakOptions.lastLineMinWidth` to the same value for the matching
     * render-aware break pressure (the public API does). 0 disables.
     */
    lastLineMinWidth: number;
    /**
     * Shrink multiplier for word spaces at font-FAMILY boundaries (runs with
     * differing `familyKey`). 0 (default): such spaces stretch but never
     * shrink — chips and pills (inline code, <kbd>) live at family
     * boundaries, their visual insets occupy part of the adjacent gap, and a
     * shrunken gap there fuses the chip with its neighbors. Native CSS
     * justification never shrinks spaces, so this also keeps chip gaps at
     * parity with the no-JS rendering. 1 restores TeX semantics (glue is
     * glue, wherever it sits); deliberate deviation otherwise.
     */
    boundaryShrink: number;
}
interface TrackingOptions {
    /** Max letterfit opening as a fraction of the line's set width. */
    max: number;
    /** Max letterfit closing as a fraction of the line's set width. */
    shrink: number;
}
interface BreakOptions {
    tolerance: number;
    /** Pass-1 (hyphenless) tolerance; < 0 skips pass 1. */
    pretolerance: number;
    linePenalty: number;
    adjDemerits: number;
    doubleHyphenDemerits: number;
    finalHyphenDemerits: number;
    /** Extra badness-only stretch for pass 3; "auto" = 12× the dominant
     * space width (≈ TeX's 3em \emergencystretch). */
    emergencyStretch: number | "auto";
    /**
     * Break-choice pressure toward paragraph endings at least this fraction
     * of the measure (0 = off, classic TeX: any ending length is free). The
     * cost model is RENDER-AWARE — it prices exactly what layoutLines will
     * do with the same value in `BuildOptions.lastLineMinWidth`: an ending
     * at or past the threshold is free; below it, the cost is the badness
     * of the word-glue stretch the render floor would apply (100·r³ with
     * r = shortfall / the ending's own glue stretch), one continuous curve
     * that automatically prices reachable endings below unreachable ones.
     * Two-phase, paragraph-level all-or-nothing: a strict RECTANGLE HUNT
     * first (the ending must be render-reachable or tolerance-cheap; body
     * lines bind at the normal tolerances), then — when no rectangle exists
     * without a worse-than-tolerance line — a compare-and-pick fallback:
     * a bounded-preference ladder (ending exempt, cost capped at INF_BAD)
     * races the exact option-off ladder, and its solution is kept only if
     * it renders a strictly longer ending, so the option can never yield a
     * shorter ending than off. Set both options to the same value; the
     * public API does.
     */
    lastLineMinWidth: number;
}
declare const defaultBuildOptions: BuildOptions;
declare const defaultBreakOptions: BreakOptions;
interface Measure {
    /** Advance of `text` (measured whole, kerning-correct) at 100% stretch. */
    width(text: string, run: RunMetrics): number;
    /** Advance of a single character, for protrusion credit. */
    charAdvance(ch: string, run: RunMetrics): number;
    /**
     * Distance from the advance-box edges to the glyph's ink (side bearings,
     * ≥ 0), for runs with `protrudeInkOnly`. Optional: when absent, protrusion
     * is never clamped.
     */
    inkBearings?(ch: string, run: RunMetrics): {
        l: number;
        r: number;
    };
}
/**
 * The item stream plus cumulative sums (over items[0..i)) that make every
 * line measure an O(1) subtraction inside the breaker.
 */
interface ParagraphItems {
    items: Item[];
    runs: readonly RunMetrics[];
    cumW: Float64Array;
    cumY: Float64Array;
    cumYfil: Float64Array;
    cumZ: Float64Array;
    cumExpY: Float64Array;
    cumExpZ: Float64Array;
    /** Tracking component of cumY (already included there), so the layout
     * can saturate tracking at its budget on stretch ratios beyond 1. The
     * shrink side needs no twin: the −1 glue clamp already bounds it. */
    cumTrackY: Float64Array;
    /** Index of the first box at or after item i (items.length if none). */
    firstBoxAfter: Int32Array;
    /** Index of the last box STRICTLY BEFORE item i (−1 if none). A break at i
     * inherits that box's protrusion and hang flex, so the breaker resolves it
     * at every breakpoint; precomputing turns the walk back over penalties and
     * glue into one array read. */
    lastBoxBefore: Int32Array;
}
/** Target width per line index (constant, or varying e.g. for text-indent). */
type LineWidths = number | readonly number[];
interface BreakResult {
    /** Item indices of the chosen breakpoints, ascending; last is the final forced penalty. */
    breakpoints: number[];
    /**
     * Which pass's tolerance produced the result. When even the final pass
     * finds no feasible path, the rescue (artificial-demerits) pass reruns
     * with tolerance opened to INF_BAD and reports the failed pass's number
     * — check `overfull` to detect rescued lines.
     */
    pass: 1 | 2 | 3;
    /** True per line that could not be fit within shrink limits. */
    overfull: boolean[];
    /**
     * The lastLineMinWidth threshold this solution was found under —
     * normally the requested value, LOWER when the rectangle hunt had to
     * descend (no arrangement reached the requested threshold within
     * tolerance, so the breaker retreated to the fullest ending it could
     * afford instead of collapsing to the option-off breaks). layoutLines
     * applies the render floor at this value.
     */
    endingMinWidth?: number;
    /** Total demerits of the chosen path (diagnostics, oracle tests). */
    demerits: number;
}
interface Line {
    /**
     * Line content is items[start..end), with trailing penalties and the
     * parfillskip glue already trimmed off (`end` equals the breakpoint item
     * except on the last line).
     */
    start: number;
    end: number;
    /** True when a hyphen glyph must be rendered at the end of this line. */
    hyphenated: boolean;
    /** Adjustment ratio the breaker optimized (diagnostics). */
    ratio: number;
    /** CSS font-stretch percent for the whole line; 100 = natural. */
    fontStretch: number;
    /** Per-space width = space.width + glueRatio·(glueRatio ≥ 0 ? stretch : shrink). */
    glueRatio: number;
    /**
     * Ratio applied to the boxes' letterfit tracking flex. Equals glueRatio
     * within [−1, 1]; beyond that it normally SATURATES at ±1 — tracking is a
     * hard budget (Bringhurst's ±3%), while spaces stretch on past their
     * nominal flexibility (they just cost badness). The sole exception is an
     * otherwise-overfull single painted token with protrusion disabled: it may
     * close to −2 so fixed halo padding stays inside the measure. glueRatio is
     * recomputed over the glue-only pool for ordinary saturated lines.
     * Fil (paragraph-ending) lines keep natural letterfit on the stretch
     * side (0 for a ragged or lastLineFit-colored ending) but equal
     * glueRatio when the ending shrinks — the breaker priced that shrink
     * against the pooled flex, tracking included.
     */
    trackRatio: number;
    /** Px the first glyph protrudes into the line-START margin (left in
     * LTR, right in RTL). */
    leftHang: number;
    /** Px the last glyph (or hyphen) protrudes past the line-END edge
     * (right in LTR, left in RTL). */
    rightHang: number;
    overfull: boolean;
    /**
     * Px by which the rendered line exceeds its target width (0 for normal
     * lines; positive for overfull lines whose glue hit the shrink limit).
     * Renderers can use it to keep overfull lines from re-wrapping.
     */
    overflowPx: number;
    /** Target width this line was set to. */
    width: number;
}
declare function lineWidthAt(widths: LineWidths, line: number): number;
/**
 * The text a context-free `text-transform` renders for `text` — the ONE case
 * mapping shared by the item model's glyph-identity lookups and the
 * measurer's length checks, so the two sides can never disagree about which
 * glyph a source character became.
 *
 * Deliberately locale-naive where the rendering engine is not (a probe under
 * lang="tr" uppercases `i` to `İ`; this maps it to `I`): it answers which
 * protrusion-table entry to look under and whether a mapping changes length,
 * never what the engine draws — widths always come from a probe carrying the
 * real property — and a miss on a locale-special glyph merely forgoes its
 * protrusion. Values other than the two supported mappings pass text through
 * unchanged.
 */
declare function caseTransformedText(text: string, transform: string | undefined): string;

/**
 * CJK (Japanese-first) line-breaking support: script detection, grapheme
 * segmentation, and the kinsoku shori (禁則処理) character classes.
 *
 * CJK text has no inter-word spaces; lines may break between almost any two
 * characters, and justification distributes space BETWEEN characters
 * (JIS X 4051's inter-character expansion) rather than at word gaps. The
 * item builder therefore turns each CJK grapheme cluster into its own box
 * and separates adjacent boxes with a zero-width break penalty plus a small
 * stretchable glue — see buildItems. Everything here is DOM-free.
 */
/**
 * One CJK character: the Han/kana/Hangul scripts by Unicode property (which
 * also covers the astral Han extensions), plus the script-Common code points
 * that live inside CJK text and must be typeset like it — CJK symbols and
 * punctuation (、。「」 etc., U+3000–303F), the kana block's Common members
 * (゠・ー — the prolonged sound mark is NOT Script=Katakana), small kana
 * extensions, and the fullwidth/halfwidth forms (！？ＡＢ｡｢ etc.).
 */
declare const CJK_CHAR: RegExp;
/**
 * Kinsoku: characters that must never START a line (行頭禁則). JIS X 4051's
 * core set: closing brackets and quotes, sentence and clause stops, mid-dots
 * and fullwidth delimiters, small kana (they modify the preceding syllable),
 * iteration marks, the prolonged sound mark, and hyphen-like dashes — plus
 * their ASCII counterparts, which mixed Japanese/Latin text uses freely.
 * A break whose next line would open with one of these is suppressed.
 */
declare const kinsokuNotAtLineStart: string;
/**
 * Kinsoku: characters that must never END a line (行末禁則): opening
 * brackets and quotes (fullwidth and ASCII). A break whose line would close
 * with one of these is suppressed.
 */
declare const kinsokuNotAtLineEnd = "\u300C\u300E\uFF08\u3014\uFF3B\uFF5B\u3008\u300A\u3010\u3018\u3016\u301D\u2018\u201C\uFF5F\u00AB\u2039\uFF62([{";
/**
 * May a line break fall between the clusters `before` | `after`? Prohibited
 * when `before` must not end a line (opening bracket) or `after` must not
 * start one (stop, closing bracket, small kana…). Multi-code-point clusters
 * are never kinsoku characters, so Set membership on the whole cluster is
 * exact.
 */
declare function cjkBreakAllowed(before: string, after: string): boolean;
/**
 * Grapheme clusters of `text` (Intl.Segmenter). The no-Segmenter fallback
 * splits by code point but keeps combining marks attached to their base, so
 * a cluster is never split by a break opportunity even on old engines.
 */
declare function graphemes(text: string): string[];

/**
 * Protrusion codes for `ch` in `table`, following character inheritance:
 * a character without its own entry takes its base letter's (À and
 * Cyrillic А protrude like A; Ё resolves Ё → Е → E). Mirrors microtype's
 * per-font \DeclareCharacterInheritance, applied universally.
 */
declare function protrusionCodes(table: ProtrusionTable, ch: string): ProtrusionCodes | undefined;
/**
 * Default character protrusion table for Latin text, in thousandths of the
 * glyph's own advance (pdfTeX \lpcode/\rpcode semantics — microtype's config
 * files use the same unit). Values are microtype's effective defaults for a
 * font without a bespoke config (its `default` + `T1-default` lists, which
 * cover Unicode text fonts under LuaLaTeX), verified against the \lpcode/
 * \rpcode registers of a live LuaLaTeX run. Merge overrides via the
 * `protrusion` option.
 */
declare const latinProtrusion: ProtrusionTable;
/**
 * The characters hanging punctuation treats as MARGINAL — not part of the
 * text's rectangle — in the style of classical book typography and CSS
 * `hanging-punctuation`. Membership, and nothing else: hanging is a
 * classification, so a character is either outside the measure or it is not.
 * How far a mark sits from the margin when it is NOT hung is a question for
 * the protrusion model, which is the other feature entirely.
 *
 * Quotes are marginal in either role at either edge; stops only at line ends.
 * `HangingPunctuationMode` then says WHERE the classification applies — line
 * ends alone, plus the paragraph opener (the CSS `first` model), or every line
 * edge — and a mark's membership never varies with where its line falls in the
 * paragraph (see #14): one mark at two depths inside a paragraph reads as a
 * misaligned edge rather than as either style.
 *
 * Brackets are deliberately absent, on either side. CSS `first` hangs the whole
 * Ps category, but no print system hangs a bracket more than slightly: measured
 * in Junicode, a line-start "(" hangs 100‰ of its advance in Affinity and 249‰
 * in InDesign, against microtype's generic 100‰. Leaving them out gives them
 * exactly that ordinary protrusion, the same depth on every line.
 *
 * The CJK stops are burasage (ぶら下げ組み): the classical Japanese
 * newspaper/book setting hangs them fully into the right margin. Their glyphs
 * sit in the left half of a fullwidth advance, so the ink lands just past the
 * margin while the em-box hangs; kinsoku already guarantees they can end a line
 * but never start one.
 */
interface HangingCharacters {
    /** Marginal at a line START. */
    readonly start: string;
    /** Marginal at a line END. */
    readonly end: string;
}
declare const hangingCharacters: HangingCharacters;
/**
 * `hangingCharacters` expressed as protrusion codes. Derived, not authored —
 * the set above is the source of truth. Exported for callers who want the
 * MAGNITUDE reading of the same characters: passed as `protrusion` it makes
 * these marks protrude their full advance without classifying them, so the
 * glyph beside a mark is credited nothing, which is what every other
 * implementation does.
 */
declare const hangingPunctuation: ProtrusionTable;
/**
 * Full-hanging policy layered over the selected protrusion model. Each name
 * says which line edges hang fully, in increasing order.
 *
 * `"first-line"` and `"all-lines"` are the original spellings of
 * `"first-line-and-line-ends"` and `"all-line-edges"`, and remain supported.
 */
type HangingPunctuationMode = false | "none" | "line-end-only" | "first-line-and-line-ends" | "all-line-edges" | "first-line" | "all-lines";
/**
 * Composes the effective protrusion tables from a base table (generic or
 * generic+per-font), the hanging-punctuation mode, and the user's explicit
 * per-char overrides (which always win). Returns the table for lines after
 * the first (`rest`) and for the paragraph's first line (`first`); the two
 * are the SAME object when no first-line distinction exists, so callers
 * can cheaply skip duplicate work.
 *
 * `credit` is the same composition WITHOUT the hang overlay — the protrusion
 * model as it would stand with hanging off. It exists for the one glyph a
 * hung mark leaves at the line's start: that glyph takes the ordinary optical
 * treatment, never a second full hang, so `“‘Twas` hangs one quote and gives
 * the second whatever a `‘` is worth at a line start. Only one mark ever
 * hangs, which is also what every other implementation does.
 *
 * It is undefined unless the MODE hangs somewhere, because crediting is
 * something the hanging POLICY does, not something a number does. "This mark
 * is not part of the line" and "this mark sticks out 1000‰" are different
 * claims: only the first says anything about what sits beside it. So a
 * `protrusion` table containing 1000 protrudes that mark and credits nothing —
 * the behaviour every other implementation has.
 *
 * CREDITING is what does not vary with the number: no table value earns it, so
 * there is no cliff between 999 and 1000 to fall off. The GEOMETRY does vary
 * there, deliberately — 999 is a partial hang and takes the ink-exit cap, 1000
 * means the mark has left the measure and clears its whole contextual advance.
 * That is the same discontinuity the two features are: a magnitude below, a
 * classification at. Codes cap at 1000, since there is nothing beyond gone.
 */
declare function composeProtrusion(base: ProtrusionTable, user: ProtrusionTable | null, hang: HangingPunctuationMode, chars?: HangingCharacters): {
    rest: ProtrusionTable;
    first: ProtrusionTable;
    credit?: ProtrusionTable;
};

/**
 * The hand-tuned microtype protrusion table for a font, looked up by the
 * first family in a CSS font-family list, or undefined when no config
 * exists for it. Merge order in the DOM layer: generic table, then this,
 * then user overrides.
 */
declare function fontProtrusion(familyList: string): ProtrusionTable | undefined;

export { type BuildOptions as B, CJK_CHAR as C, type ExpansionOptions as E, type Glue as G, type HangingPunctuationMode as H, type Item as I, type LineWidths as L, type Measure as M, type ParagraphItems as P, type RunText as R, type TrackingOptions as T, type RunMetrics as a, type BreakOptions as b, type BreakResult as c, type Line as d, type Box as e, type GlueSpec as f, type InlineEdge as g, ItemType as h, type Penalty as i, type ProtrusionCodes as j, type ProtrusionTable as k, caseTransformedText as l, cjkBreakAllowed as m, composeProtrusion as n, defaultBreakOptions as o, defaultBuildOptions as p, fontProtrusion as q, graphemes as r, hangingCharacters as s, hangingPunctuation as t, kinsokuNotAtLineEnd as u, kinsokuNotAtLineStart as v, latinProtrusion as w, lineWidthAt as x, protrusionCodes as y };
