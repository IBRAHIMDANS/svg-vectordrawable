import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { XastElement } from './ast.js';
import { toAndroidColor } from './color.js';
import type { TextLayout } from './context.js';
import { isDisplayNone } from './elements.js';
import { fillOf, INHERITABLE, resolveStyle, TEXT_PROPERTIES, type Inherited } from './inherited.js';
import { parseStyle, presentation } from './style.js';
import { parseLength, parseOpacity } from './units.js';

// `<text>` as glyph outlines, for the `fonts` option (Node only: the browser builds replace this
// module with src/text-browser.ts). The font library, the optional peer dependency opentype.js, is
// loaded on the first `<text>` to draw, so that a conversion without text never loads it.

/** The part of opentype.js used here. */
interface OpentypeFont {
    charToGlyphIndex: (char: string) => number;
    getAdvanceWidth: (text: string, fontSize: number, options?: object) => number;
    getPath: (text: string, x: number, y: number, fontSize: number, options?: object) => { commands: PathCommand[] };
    tables: Record<string, unknown>;
}

/** A glyph outline command of opentype.js (absolute coordinates, y down). */
interface PathCommand {
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
}

interface OpentypeModule {
    parse: (buffer: Uint8Array) => OpentypeFont;
}

const OPENTYPE = 'opentype.js';

let opentype: OpentypeModule | undefined;

/**
 * Loads opentype.js on first use; a string saying how to install it when it cannot be loaded.
 * Synchronous (createRequire), so that `convert` stays synchronous.
 */
function loadOpentype(): OpentypeModule | string {
    if (opentype) return opentype;
    try {
        opentype = createRequire(import.meta.url)(OPENTYPE) as OpentypeModule;
        return opentype;
    } catch (err) {
        const { code, message } = err as NodeJS.ErrnoException;
        if (code === 'MODULE_NOT_FOUND' && message.includes(`'${OPENTYPE}'`))
            return `the fonts option needs ${OPENTYPE}, which is not installed: npm install ${OPENTYPE}`;
        return `the fonts option could not load ${OPENTYPE}: ${message.split('\n')[0]}`;
    }
}

const num = (v: number | undefined): string => String(Number((v ?? 0).toFixed(6)));

/**
 * SVG path data of glyph outlines, every contour closed. Written here rather than with opentype.js'
 * `toPathData`, whose rounding cache yields `NaN` coordinates for some layouts (2.0.0), and whose
 * outlines end each contour with a line back to its start but no `Z` (which a stroke needs).
 */
function outlinePathData(commands: readonly PathCommand[]): string {
    const out: string[] = [];
    let start: PathCommand | undefined;
    commands.forEach((c, i) => {
        if (c.type === 'M') {
            if (start) out.push('Z');
            start = c;
            out.push(`M${num(c.x)} ${num(c.y)}`);
        } else if (c.type === 'L') {
            // The closing line back to the start: Z draws it.
            const closing =
                commands[i + 1]?.type !== 'L' && commands[i + 1]?.type !== 'Q' && commands[i + 1]?.type !== 'C';
            if (!(closing && start && num(c.x) === num(start.x) && num(c.y) === num(start.y)))
                out.push(`L${num(c.x)} ${num(c.y)}`);
        } else if (c.type === 'Q') out.push(`Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`);
        else if (c.type === 'C')
            out.push(`C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`);
        else if (c.type === 'Z') {
            if (start) out.push('Z');
            start = undefined;
        }
    });
    if (start) out.push('Z');
    return out.join('');
}

/** A font-family name as a `fonts` key: case-insensitive, runs of spaces as one. */
const fontKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The families of a `font-family` list, unquoted, in order. */
function families(value: string): string[] {
    const out: string[] = [];
    for (const m of value.matchAll(/\s*(?:"([^"]*)"|'([^']*)'|([^,]+))\s*(?:,|$)/g)) {
        const name = m[1] ?? m[2] ?? m[3] ?? '';
        if (name.trim()) out.push(name);
    }
    return out;
}

/** Numeric `font-weight` (1–1000), or undefined for a relative / invalid one. */
function fontWeight(value: string | undefined): number | undefined {
    const v = (value ?? 'normal').toLowerCase();
    if (v === 'normal') return 400;
    if (v === 'bold') return 700;
    const n = Number(v);
    return /^\d+(\.\d+)?$/.test(v) && n >= 1 && n <= 1000 ? n : undefined;
}

/** The `fonts` keys a family is looked up with, for a weight and style (see `ConvertOptions.fonts`). */
function variantKeys(family: string, weight: number, italic: boolean): string[] {
    const weights = weight === 400 ? ['', ' 400', ' regular'] : weight === 700 ? [' bold', ' 700'] : [` ${weight}`];
    return weights.map((w) => fontKey(`${family}${w}${italic ? ' italic' : ''}`));
}

/** CSS absolute-size keywords, in px (CSS Fonts 4, from `medium` = 16 px). */
const FONT_SIZE_KEYWORDS: Record<string, number> = {
    'xx-small': 9,
    'x-small': 10,
    small: 13,
    medium: 16,
    large: 18,
    'x-large': 24,
    'xx-large': 32,
    'xxx-large': 48,
};

/** A zero length (`0`, `0px`, `0em`…) or `normal`. */
const isZeroOrNormal = (v: string): boolean => v.toLowerCase() === 'normal' || /^[+-]?0*\.?0+([a-z]+|%)?$/i.test(v);

/**
 * Text properties with the values that lay text out as here (left-to-right, horizontal, alphabetic
 * baseline, no extra spacing, default glyphs). Any other value is reported.
 */
const NEUTRAL: Record<string, (v: string) => boolean> = {
    'letter-spacing': isZeroOrNormal,
    'word-spacing': isZeroOrNormal,
    'text-anchor': (v) => /^(start|middle|end)$/i.test(v),
    direction: (v) => /^ltr$/i.test(v),
    'writing-mode': (v) => /^(horizontal-tb|lr|lr-tb)$/i.test(v),
    'dominant-baseline': (v) => /^(auto|alphabetic)$/i.test(v),
    // The shorthand is not parsed: its size and family would be missed.
    font: () => false,
    'font-variant': (v) => /^normal$/i.test(v),
    'font-variant-caps': (v) => /^normal$/i.test(v),
    'font-variant-ligatures': (v) => /^normal$/i.test(v),
    'font-variant-numeric': (v) => /^normal$/i.test(v),
    'text-transform': (v) => /^none$/i.test(v),
    'font-stretch': (v) => /^(normal|100%)$/i.test(v),
    'font-feature-settings': (v) => /^normal$/i.test(v),
    'font-variation-settings': (v) => /^normal$/i.test(v),
    'font-size-adjust': (v) => /^none$/i.test(v),
    'font-kerning': (v) => /^(auto|normal|none)$/i.test(v),
    'white-space': (v) => /^(normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/i.test(v),
};

/** Not inherited: read on the `<text>` itself. */
const OWN_NEUTRAL: Record<string, (v: string) => boolean> = {
    'alignment-baseline': (v) => /^(auto|baseline|alphabetic)$/i.test(v),
    'baseline-shift': (v) => /^(baseline|0)$/i.test(v),
    'text-decoration': (v) => /^none$/i.test(v),
};

/** Attributes positioning glyphs one by one, or stretching the text: not supported. */
const GLYPH_ATTRS = ['dx', 'dy', 'rotate', 'textLength'];

/** `<tspan>` attributes that change nothing here (x / y are checked apart). */
const PLAIN_TSPAN_ATTRS = new Set(['x', 'y', 'id']);

/**
 * Inherited properties a `<tspan>` may declare (attribute or `style`) when its computed value is the
 * `<text>`'s: svgo drops such a declaration, so both modes draw it. Any other value is reported.
 * The cascade's own lists (inherited.ts), so that the two cannot diverge; `font` (the shorthand) is
 * among them, but a `<text>` with a `font` is reported anyway.
 */
const TSPAN_INHERITED: ReadonlySet<string> = new Set(['fill', 'stroke', ...INHERITABLE, ...TEXT_PROPERTIES]);

/**
 * Properties a `<tspan>` may declare at their initial value, where they change nothing: the
 * non-inherited ones, and the inherited ones the glyph outlines ignore (`clip-rule`, rendering hints,
 * markers…). svgo drops most of them there (presentation defaults, or attributes unknown on a
 * `<tspan>`), so both modes draw it. Keywords compared lowercased; opacities and `stop-color` by value.
 */
const TSPAN_INITIAL: Record<string, (value: string) => boolean> = {
    opacity: (v) => parseOpacity(v, 0) === 1,
    'stop-opacity': (v) => parseOpacity(v, 0) === 1,
    'stop-color': (v) => toAndroidColor(v, 1, '') === toAndroidColor('black', 1, ''),
    ...Object.fromEntries(
        Object.entries({
            'alignment-baseline': ['auto', 'baseline'],
            'baseline-shift': ['baseline'],
            clip: ['auto'],
            'clip-path': ['none'],
            'clip-rule': ['nonzero'],
            'color-interpolation': ['srgb'],
            'color-rendering': ['auto'],
            display: ['inline'],
            filter: ['none'],
            'glyph-orientation-horizontal': ['0', '0deg'],
            'glyph-orientation-vertical': ['auto'],
            'image-rendering': ['auto'],
            isolation: ['auto'],
            kerning: ['auto'],
            marker: ['none'],
            'marker-end': ['none'],
            'marker-mid': ['none'],
            'marker-start': ['none'],
            mask: ['none'],
            'mix-blend-mode': ['normal'],
            'shape-rendering': ['auto'],
            'text-decoration': ['none'],
            'text-overflow': ['clip'],
            'text-rendering': ['auto'],
            'unicode-bidi': ['normal'],
            'vector-effect': ['none'],
        }).map(([prop, initial]) => [prop, (v: string) => initial.includes(v.trim().toLowerCase())]),
    ),
};

/** true when a `<tspan>` declaration (attribute or `style`) may be drawn: compared afterwards when inherited. */
const tspanAllowed = (prop: string, value: string): boolean =>
    TSPAN_INHERITED.has(prop) || (TSPAN_INITIAL[prop]?.(value) ?? false);

/**
 * Text needing shaping opentype.js does not do like a browser: combining marks (Indic and South-East
 * Asian scripts, emoji variation sequences), right-to-left scripts, joiners and bidi controls
 * (format characters). Reported rather than drawn differently.
 */
const COMPLEX_SCRIPT =
    /[\p{M}\p{Cf}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

/** A single `x` / `y` length (percentages of the viewport side `ref`); undefined when unset. */
function singleLength(value: string | undefined, ref: number): number | string | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const list = value.trim().split(/[\s,]+/);
    if (list.length > 1) return 'per-character x / y positions are not supported';
    const n = parseLength(list[0], ref);
    return Number.isNaN(n) ? `invalid position ${value.trim()}` : n;
}

const nodeText = (node: XastElement): string => (node as { value?: string }).value ?? '';

/** A paint or color as compared here: the Android color when parseable (`red` = `#f00`), else as written. */
const colorKey = (v: string | undefined, current: string): string | undefined =>
    v === undefined ? undefined : (toAndroidColor(v, 1, current) ?? v.trim());

/** A `font-size` in px (`medium` when unset), or as written when not a plain length. */
function fontSizeKey(v: string | undefined): string {
    const value = (v ?? 'medium').trim().toLowerCase();
    const px = FONT_SIZE_KEYWORDS[value] ?? parseLength(value);
    return Number.isNaN(px) ? value : String(px);
}

/** A unitless or `px` number: the only lengths compared by value (`em` / `%` depend on context). */
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px)?$/i;

/** A keyword lowercased, `initial` when unset. */
const keywordKey =
    (initial: string) =>
    (v: string | undefined): string =>
        (v ?? initial).trim().toLowerCase();

/** A plain number or `px` length by value (`initial` when unset), anything else as written. */
const numberKey =
    (initial: string) =>
    (v: string | undefined): string => {
        const value = (v ?? initial).trim().toLowerCase();
        return PLAIN_NUMBER.test(value) ? String(parseFloat(value)) : value;
    };

/** A spacing: `normal` is 0. */
const spacingKey = (v: string | undefined): string => numberKey('0')(v?.trim().toLowerCase() === 'normal' ? '0' : v);

/**
 * Computed values as compared by {@link renderedKey}: an unset property is its initial value, so that
 * a `<tspan>` restating it (`font-weight="normal"` under a `<text>` that sets none) changes nothing,
 * as in `optimize: true` where svgo drops such a default. Keyed by `Inherited.text` name, then by
 * `Inherited` field.
 */
const TEXT_KEYS: Record<string, (v: string | undefined) => string> = {
    'font-size': fontSizeKey,
    'font-weight': (v) => String(fontWeight(v) ?? v!.trim().toLowerCase()),
    'font-style': keywordKey('normal'),
    'font-variant': keywordKey('normal'),
    'font-variant-caps': keywordKey('normal'),
    'font-variant-ligatures': keywordKey('normal'),
    'font-variant-numeric': keywordKey('normal'),
    'font-kerning': keywordKey('auto'),
    'font-size-adjust': keywordKey('none'),
    'font-feature-settings': keywordKey('normal'),
    'font-variation-settings': keywordKey('normal'),
    'letter-spacing': spacingKey,
    'word-spacing': spacingKey,
    'text-transform': keywordKey('none'),
    'text-anchor': keywordKey('start'),
    direction: keywordKey('ltr'),
    'dominant-baseline': keywordKey('auto'),
    'white-space': keywordKey('normal'),
};
const STYLE_KEYS: Record<string, (v: string | undefined) => string> = {
    fillRule: keywordKey('nonzero'),
    strokeWidth: numberKey('1'),
    strokeLinecap: keywordKey('butt'),
    strokeLinejoin: keywordKey('miter'),
    strokeMiterlimit: numberKey('4'),
    strokeDasharray: keywordKey('none'),
    strokeDashoffset: numberKey('0'),
    paintOrder: keywordKey('normal'),
    visibility: keywordKey('visible'),
};

/** `record` with each `keys` entry replaced by its normalized value. */
function normalized(
    record: Readonly<Record<string, unknown>>,
    keys: Record<string, (v: string | undefined) => string>,
) {
    const out: Record<string, unknown> = { ...record };
    for (const [k, key] of Object.entries(keys)) out[k] = key(record[k] as string | undefined);
    return out;
}

/** The set entries of a record, sorted by key and flattened (an unset key is a key set to undefined). */
const entries = (record: object): unknown[] =>
    Object.entries(record)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .flat();

/** What of a computed style draws text: compared to tell whether a `<tspan>` changes it. */
function renderedKey(s: Inherited): unknown[] {
    const { fill: _fill, stroke, color, fillServer, strokeServer, text, ...rest } = s;
    return [
        colorKey(fillOf(s, true), color),
        colorKey(stroke ?? 'none', color),
        colorKey(color, color),
        fillServer?.keyword,
        fillServer?.context,
        strokeServer?.keyword,
        strokeServer?.context,
        ...entries(normalized(text ?? {}, TEXT_KEYS)),
        ...entries(normalized(rest, STYLE_KEYS)),
    ];
}

/**
 * The first own attribute of a `<tspan>` that may change how its text is drawn, compared with the
 * `<text>` style `parent`; undefined when it declares only inherited values equal to the parent's.
 * A property that cannot be drawn is named whether it is an attribute or a `style` declaration, so
 * both forms give the same reason.
 */
function tspanChange(tspan: XastElement, parent: Inherited): string | undefined {
    const attrs = tspan.attributes ?? {};
    const own = Object.keys(attrs).filter((a) => !PLAIN_TSPAN_ATTRS.has(a));
    if (own.length === 0) return undefined;
    const declarations = own.flatMap((a): [string, string][] =>
        a === 'style' ? Object.entries(parseStyle(attrs.style)) : [[a, attrs[a] ?? '']],
    );
    const unknown = declarations.find(([p, v]) => !tspanAllowed(p, v));
    if (unknown !== undefined) return unknown[0];
    const before = renderedKey(parent);
    const after = renderedKey(resolveStyle(tspan, parent));
    const same = before.length === after.length && before.every((v, i) => v === after[i]);
    return same ? undefined : own[0];
}

interface Content {
    text: string;
    /** Position set by a leading `<tspan>`, overriding the `<text>` one. */
    x?: string;
    y?: string;
}

/**
 * The characters of a single-line `<text>` (text nodes, plain `<tspan>`s), or why it is not one.
 * `preserve`: whitespace is kept (decides whether something precedes a positioned `<tspan>`);
 * `style`: the `<text>`'s computed style, which a `<tspan>` may restate (see {@link tspanChange}).
 */
function textContent(el: XastElement, preserve: boolean, style: Inherited): Content | string {
    let text = '';
    let x: string | undefined;
    let y: string | undefined;
    let positioned = false;
    for (const child of el.children ?? []) {
        if (child.type === 'text' || child.type === 'cdata') text += nodeText(child);
        if (child.type !== 'element') continue;
        const name = child.name ?? '';
        if (['title', 'desc', 'metadata'].includes(name)) continue;
        if (name !== 'tspan') return `<${name}> in <text> is not supported`;
        // Not rendered, nor its text (svgo removes it): skipped whatever else it declares.
        if (isDisplayNone(child)) continue;
        const attrs = child.attributes ?? {};
        const extra = tspanChange(child, style);
        if (extra !== undefined) return `<tspan> with its own ${extra} is not supported`;
        if (attrs.x !== undefined || attrs.y !== undefined) {
            // A positioned <tspan> starts a new chunk: only as the first content is it a single line.
            if (positioned || (preserve ? text !== '' : text.trim() !== ''))
                return 'positioned <tspan>s (multi-line text) are not supported';
            positioned = true;
            ({ x, y } = attrs);
        }
        for (const c of child.children ?? []) {
            if (c.type === 'text' || c.type === 'cdata') text += nodeText(c);
            else if (c.type === 'element') return `<${c.name}> in <tspan> is not supported`;
        }
    }
    return { text, x, y };
}

/**
 * Whitespace as resvg and browsers handle it: newlines and tabs are spaces; without `xml:space=
 * "preserve"` (or a CSS `white-space` keeping spaces), runs of spaces collapse and the ends are
 * trimmed. (SVG 1.1 removed newlines instead; current renderers treat them as spaces.)
 */
function collapseWhitespace(text: string, preserve: boolean): string {
    const spaced = text.replace(/[\n\r\t]/g, ' ');
    return preserve ? spaced : spaced.trim().replace(/ {2,}/g, ' ');
}

/**
 * Creates the `<text>` layout of one conversion from the `fonts` option, validated here (TypeError).
 * Font files are read and parsed on first use, once per conversion.
 */
export function textLayout(fonts: Record<string, string | Uint8Array>): TextLayout {
    if (typeof fonts !== 'object' || fonts === null || Array.isArray(fonts))
        throw new TypeError('Invalid fonts: expected an object of font-family name → font file path or bytes');
    const sources = new Map<string, string | Uint8Array>();
    for (const [name, source] of Object.entries(fonts)) {
        if (typeof source !== 'string' && !(source instanceof Uint8Array))
            throw new TypeError(`Invalid fonts[${JSON.stringify(name)}]: expected a font file path or a Uint8Array`);
        sources.set(fontKey(name), source);
    }
    const parsed = new Map<string, OpentypeFont>();

    const fontOf = (key: string, lib: OpentypeModule): OpentypeFont => {
        let font = parsed.get(key);
        if (font) return font;
        const source = sources.get(key)!;
        const what = typeof source === 'string' ? source : `the bytes given for "${key}"`;
        let bytes: Uint8Array;
        try {
            bytes = typeof source === 'string' ? readFileSync(source) : source;
        } catch (err) {
            throw new Error(`Cannot read the font file ${what}: ${(err as Error).message}`, { cause: err });
        }
        try {
            font = lib.parse(bytes);
        } catch (err) {
            throw new Error(`Cannot parse the font ${what}: ${(err as Error).message}`, { cause: err });
        }
        parsed.set(key, font);
        return font;
    };

    return (el: XastElement, style: Inherited) => {
        const attrs = el.attributes ?? {};
        const props = style.text ?? {};
        const glyphAttr = GLYPH_ATTRS.find((a) => attrs[a] !== undefined && attrs[a].trim() !== '');
        if (glyphAttr !== undefined) return { reason: `${glyphAttr} is not supported` };
        for (const [prop, ok] of Object.entries(NEUTRAL)) {
            const v = props[prop];
            if (v !== undefined && !ok(v)) return { reason: `${prop}: ${v} is not supported` };
        }
        for (const [prop, ok] of Object.entries(OWN_NEUTRAL)) {
            const v = presentation(el, prop)?.trim();
            if (v !== undefined && !ok(v)) return { reason: `${prop}: ${v} is not supported` };
        }

        const whiteSpace = props['white-space']?.toLowerCase();
        const preserve =
            whiteSpace === undefined
                ? props['xml:space'] === 'preserve'
                : ['pre', 'pre-wrap', 'break-spaces'].includes(whiteSpace);
        const content = textContent(el, preserve, style);
        if (typeof content === 'string') return { reason: content };
        if (/[\n\r]/.test(content.text) && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(whiteSpace ?? ''))
            return { reason: 'multi-line text is not supported' };
        const text = collapseWhitespace(content.text, preserve);
        if (text === '') return { d: '' };

        const x = singleLength(content.x ?? attrs.x, style.viewport.width);
        const y = singleLength(content.y ?? attrs.y, style.viewport.height);
        if (typeof x === 'string') return { reason: x };
        if (typeof y === 'string') return { reason: y };

        const sizeValue = (props['font-size'] ?? 'medium').toLowerCase();
        const size = FONT_SIZE_KEYWORDS[sizeValue] ?? parseLength(sizeValue);
        if (!(size >= 0)) return { reason: `font-size: ${sizeValue} is not supported` };
        if (size === 0) return { d: '' };

        const weight = fontWeight(props['font-weight']);
        if (weight === undefined) return { reason: `font-weight: ${props['font-weight']} is not supported` };
        const fontStyle = (props['font-style'] ?? 'normal').toLowerCase();
        if (!/^(normal|italic|oblique\b.*)$/.test(fontStyle))
            return { reason: `font-style: ${fontStyle} is not supported` };
        const italic = fontStyle !== 'normal';
        const familyValue = props['font-family'];
        const key = families(familyValue ?? '')
            .flatMap((f) => variantKeys(f, weight, italic))
            .find((k) => sources.has(k));
        if (key === undefined) {
            const variant = [weight === 400 ? '' : ` weight ${weight}`, italic ? ' italic' : ''].join('');
            return {
                reason:
                    familyValue === undefined
                        ? 'no font-family is set'
                        : `no font for font-family ${familyValue}${variant} in the fonts option`,
            };
        }
        if (COMPLEX_SCRIPT.test(text)) return { reason: 'text needing complex shaping is not supported' };

        const lib = loadOpentype();
        if (typeof lib === 'string') return { reason: lib };
        const font = fontOf(key, lib);
        if (font.tables.colr || font.tables.svg) return { reason: `the font for "${key}" is a color font` };
        for (const char of text)
            if (!(font.charToGlyphIndex(char) > 0))
                return {
                    reason: `the font for "${key}" has no glyph for "${char}" (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`,
                };

        const options = { kerning: props['font-kerning']?.toLowerCase() !== 'none', drawLayers: false, drawSVG: false };
        const anchor = (props['text-anchor'] ?? 'start').toLowerCase();
        // opentype.js throws on some lookups it does not implement (GSUB lookup type 6 format 2 in
        // DejaVu Sans, Fira Code…), whatever the features: the text is skipped, like a color font.
        let commands: PathCommand[];
        try {
            const shift =
                anchor === 'start' ? 0 : font.getAdvanceWidth(text, size, options) / (anchor === 'end' ? 1 : 2);
            ({ commands } = font.getPath(text, (x ?? 0) - shift, y ?? 0, size, options));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                reason: `the font for "${key}" cannot be shaped by opentype.js (${message.split('\n', 1)[0]!.trim()})`,
            };
        }
        return { d: outlinePathData(commands) };
    };
}
