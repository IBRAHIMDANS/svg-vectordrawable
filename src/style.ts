import type { Viewport, XastElement } from './ast.js';
import {
    aroundOrigin,
    formatMatrix,
    IDENTITY,
    isIdentity,
    multiply,
    parseCssTransform,
    parseTransform,
    parseTransformOrigin,
    type Matrix,
} from './transform.js';
import type { Warning } from './types.js';
import { parseLength } from './units.js';
import { validPathData } from './pathData.js';
import { toAndroidColor } from './color.js';
// Cycle with viewport.ts (which reads `parseStyle`…): only called at run time, never at load.
import { disablingViewBox, nestedLayout, rootLayout } from './viewport.js';
// Cycle with elements.ts (which reads `presentation`…): only called at run time, never at load.
import { foreignElements, isNotRendered, isNotRenderedButForPathData, switchChild } from './elements.js';

/** The `!important` marker ending a declaration value (CSS Syntax allows whitespace after `!`). */
const IMPORTANT = /\s*!\s*important\s*$/i;

/** Brackets that open a block: a `;` inside one does not end the declaration. */
const OPENING = new Set(['(', '[', '{']);
const CLOSING = new Set([')', ']', '}']);

/**
 * Splits a declaration list on its top-level `;` only (CSS Syntax 3 §5.4.4): one inside a block
 * (`url('data:…;base64,…')`, `[…]`, `{…}`) or a string (`'a;b'`, backslash escapes included) belongs
 * to the value. An unclosed block runs to the end, so the rest is one (invalid) declaration; a string
 * ends at its quote or at a newline.
 */
function topLevelDeclarations(style: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < style.length; i++) {
        const c = style[i]!;
        if (c === '\\') i++;
        else if (quote) {
            if (c === quote || c === '\n') quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (OPENING.has(c)) depth++;
        else if (CLOSING.has(c)) depth = Math.max(0, depth - 1);
        else if (c === ';' && depth === 0) {
            out.push(style.slice(start, i));
            start = i + 1;
        }
    }
    out.push(style.slice(start));
    return out;
}

/**
 * Declarations of an inline `style` attribute, in source order, as `[lowercase name, value,
 * important]` triples: the value is trimmed and stripped of its `!important` marker, which sets
 * `important`. Values are not validated (see {@link parseStyle}).
 */
export function styleDeclarations(style: string | undefined): [string, string, boolean][] {
    if (!style) return [];
    const out: [string, string, boolean][] = [];
    for (const decl of topLevelDeclarations(style)) {
        const i = decl.indexOf(':');
        if (i <= 0) continue;
        const raw = decl.slice(i + 1).trim();
        const value = raw.replace(IMPORTANT, '').trim();
        out.push([decl.slice(0, i).trim().toLowerCase(), value, value.length !== raw.length]);
    }
    return out;
}

/**
 * The declarations of an inline `style` that apply, with the cascade of a single declaration block
 * (CSS 2.1 §4.2, CSS Cascade §6.4): a declaration whose value is invalid for its property is ignored
 * (see {@link isValidPropertyValue}), an `!important` one wins over the normal ones, and otherwise
 * the last one wins. Keyed by lowercase name, in the order of each property's first declaration.
 */
function cascade(style: string | undefined): Map<string, { value: string; important: boolean }> {
    const out = new Map<string, { value: string; important: boolean }>();
    for (const [name, value, important] of styleDeclarations(style)) {
        if (!isValidPropertyValue(name, value) || (!important && out.get(name)?.important)) continue;
        out.set(name, { value, important });
    }
    return out;
}

/**
 * Parses an inline `style` attribute into a lowercase-keyed map of the declarations that apply (see
 * {@link cascade}), stripped of their `!important` markers.
 */
export function parseStyle(style: string | undefined): Record<string, string> {
    return Object.fromEntries([...cascade(style)].map(([name, { value }]) => [name, value]));
}

/**
 * An inline `style` rewritten to the declarations that apply (see {@link cascade}), one per property,
 * `!important` kept; the input unchanged when nothing is dropped. For a tool that resolves repeated
 * declarations itself without validating them (svgo's `minifyStyles` keeps the last one, even
 * invalid): run before it, the result means the same and leaves it nothing to get wrong.
 */
export function cascadedStyle(style: string): string {
    const applied = cascade(style);
    if (applied.size === styleDeclarations(style).length) return style;
    return [...applied]
        .map(([name, { value, important }]) => `${name}:${value}${important ? '!important' : ''}`)
        .join(';');
}

/**
 * Reads a property from the inline `style` first (its declaration that applies, see {@link
 * parseStyle}), then from the attribute of the same name.
 */
export function presentation(el: XastElement, name: string): string | undefined {
    const attrs = el.attributes ?? {};
    return parseStyle(attrs.style)[name] ?? attrs[name];
}

/** CSS-wide keywords, valid for every property. */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
/** Substitution functions: the value is only checked once substituted, at computed-value time. */
const SUBSTITUTION = /\b(?:var|env|attr)\(/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const NUMBER_OR_PERCENTAGE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;
const NUMBER_WITH_UNIT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]+)$/i;
/** Units of a valid CSS length the converter cannot resolve (font, viewport or container relative, `Q`). */
const UNRESOLVABLE_UNIT = /^(?:r?(?:ex|ch|cap|ic|lh)|[sld]?(?:vw|vh|vi|vb|vmin|vmax)|cq(?:w|h|i|b|min|max)|q)$/i;
/** Math and substitution functions a browser evaluates and the converter does not. */
const UNRESOLVABLE_FUNCTION = /^(?:calc|var|env|min|max|clamp|round|mod|rem|abs|sign)\(/i;
/** Paints that are not colors: `none`, a paint server reference (with its fallback), a context paint. */
const NON_COLOR_PAINT = /^(?:none|url\(.*|context-(?:fill|stroke))$/i;
/** A functional notation (`color-mix()`, relative colors…): left to the paint code, which reports what it cannot read. */
const FUNCTION = /^[a-z-]+\(.*\)$/is;

/**
 * Whether a declaration value is a length a browser applies but the converter cannot resolve
 * (`1ex`, `2vw`, `calc()`…), as opposed to garbage (`foo`, `1foo`) that a browser drops.
 * `nonNegative`: a negative number with such a unit is invalid.
 */
export function isUnresolvableCssLength(value: string, nonNegative: boolean): boolean {
    if (UNRESOLVABLE_FUNCTION.test(value)) return true;
    const m = NUMBER_WITH_UNIT.exec(value);
    return !!m && UNRESOLVABLE_UNIT.test(m[2]!) && (!nonNegative || parseFloat(m[1]!) >= 0);
}

/** A CSS `<length-percentage>` (unitless numbers allowed, as in SVG), resolvable here or not. */
function isLengthPercentage(value: string, nonNegative: boolean): boolean {
    const length = parseLength(value, 1); // any reference: only validity matters here
    if (!Number.isNaN(length)) return !nonNegative || length >= 0;
    return isUnresolvableCssLength(value, nonNegative);
}

/** A value made of 1 to `max` distinct keywords of `allowed` (case-insensitive). */
function isKeywordList(value: string, allowed: ReadonlySet<string>, max: number): boolean {
    const words = value.toLowerCase().split(/\s+/);
    return words.length <= max && new Set(words).size === words.length && words.every((w) => allowed.has(w));
}

const keywords = (...words: string[]): ReadonlySet<string> => new Set(words.map((w) => w.toLowerCase()));
const OVERFLOW = keywords('visible', 'hidden', 'clip', 'scroll', 'auto');
const DISPLAY_OUTSIDE = keywords('block', 'inline', 'run-in');
const DISPLAY_INSIDE = keywords('flow', 'flow-root', 'table', 'flex', 'grid', 'ruby', 'math');
const DISPLAY_SINGLE = keywords(
    'none',
    'contents',
    'list-item',
    'inline-block',
    'inline-table',
    'inline-flex',
    'inline-grid',
    'inline-list-item',
    'table-row-group',
    'table-header-group',
    'table-footer-group',
    'table-row',
    'table-cell',
    'table-column-group',
    'table-column',
    'table-caption',
    'ruby-base',
    'ruby-text',
    'ruby-base-container',
    'ruby-text-container',
);
const DISPLAY_MULTI = new Set([...DISPLAY_OUTSIDE, ...DISPLAY_INSIDE, 'list-item']);

function isDisplay(value: string): boolean {
    const v = value.toLowerCase();
    return DISPLAY_SINGLE.has(v) || isKeywordList(v, DISPLAY_MULTI, 3);
}

/** A color, or for `fill` / `stroke` a paint; a functional notation is accepted (see {@link FUNCTION}). */
function isColor(value: string, paint: boolean): boolean {
    if (paint && NON_COLOR_PAINT.test(value)) return true;
    return FUNCTION.test(value) || toAndroidColor(value, 1, '#000000') !== null;
}

function isDashArray(value: string): boolean {
    if (value.toLowerCase() === 'none') return true;
    const items = cssListItems(value);
    return !!items && items.every((item) => isLengthPercentage(item, true));
}

/**
 * `path("…")` / `path('…')`: the CSS `d` property takes the path string alone (no fill rule). The
 * string is a CSS string token: any character but its quote and a newline, or an escape.
 */
const CSS_PATH_FUNCTION = /^path\(\s*(?:"((?:[^"\\\n\r\f]|\\[\s\S])*)"|'((?:[^'\\\n\r\f]|\\[\s\S])*)')\s*\)$/i;
/** One escape of a CSS string: hex digits and one optional whitespace, an escaped newline, or a character. */
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/gi;

/**
 * Decodes the escapes of a CSS string's content (CSS Syntax 3 §4.3.5, §4.3.7): `\68 ` → `h`, an
 * escaped newline is removed, `\` before another character keeps it; a zero, surrogate or
 * out-of-range code point gives U+FFFD. svgo's csso does the same with `optimize: true`.
 */
function decodeCssString(s: string): string {
    return s.replace(
        CSS_ESCAPE,
        (_, hex: string | undefined, newline: string | undefined, char: string | undefined) => {
            if (newline !== undefined) return '';
            if (char !== undefined) return char;
            const cp = parseInt(hex!, 16);
            return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? '\uFFFD' : String.fromCodePoint(cp);
        },
    );
}

/** The decoded string of a CSS `path()` value (see {@link CSS_PATH_FUNCTION}); `undefined` for another value. */
export function cssPathString(value: string): string | undefined {
    const m = CSS_PATH_FUNCTION.exec(value);
    return m ? decodeCssString(m[1] ?? m[2]!) : undefined;
}

/**
 * Whether `d` is path data without error (SVG 2 §9.3.9), movetos alone included: they are valid but
 * draw nothing, which `validPathData` reports as null. A complete segment appended after an error
 * leaves it an error, after valid data keeps it valid.
 */
export function isPathDataString(d: string): boolean {
    const probe = `${d} L0 0`;
    return validPathData(probe) === probe;
}

/**
 * CSS `d` values valid at parse time whose computed value the converter cannot know: substitution
 * functions, cascade keywords other than the initial value.
 */
export const UNRESOLVED_CSS_PATH_DATA = /^(?:inherit|revert|revert-layer)$|(?:var|env|attr)\(/i;

/**
 * CSS `d` (SVG 2 §9.3.1): `none`, or `path()` whose decoded string is empty or path data without
 * error (an error makes the declaration invalid at parse time, unlike the attribute).
 */
function isCssPathData(v: string): boolean {
    if (v.toLowerCase() === 'none') return true;
    const d = cssPathString(v);
    return d !== undefined && (!d.trim() || isPathDataString(d));
}

/** A CSS `<number>` (CSS Syntax 3 §4.3.12: `1.` is not one, unlike the SVG attribute syntax). */
const CSS_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
const CSS_DIMENSION = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)([a-z]+|%)$/i;
const LENGTH_UNIT =
    /^(?:px|cm|mm|q|in|pt|pc|r?(?:em|ex|ch|cap|ic|lh)|[sld]?(?:vw|vh|vi|vb|vmin|vmax)|cq(?:w|h|i|b|min|max))$/i;
const ANGLE_UNIT = /^(?:deg|rad|grad|turn)$/i;
/** A CSS dimension (or a bare zero, valid as a length or an angle) whose unit matches `unit`. */
const isDimension = (v: string, unit: RegExp): boolean => {
    if (CSS_NUMBER.test(v)) return parseFloat(v) === 0;
    const m = CSS_DIMENSION.exec(v);
    return !!m && unit.test(m[2]!);
};
/** Argument types of the CSS transform functions (CSS Transforms 1 §12, 2 §12): a function nested in an argument (`calc()`…) is not typed. */
type TransformArg = (v: string) => boolean;
const NUM: TransformArg = (v) => CSS_NUMBER.test(v);
const NUM_PCT: TransformArg = (v) => CSS_NUMBER.test(v) || (v.endsWith('%') && CSS_NUMBER.test(v.slice(0, -1)));
const LEN: TransformArg = (v) => isDimension(v, LENGTH_UNIT);
const LEN_PCT: TransformArg = (v) => LEN(v) || (v.endsWith('%') && CSS_NUMBER.test(v.slice(0, -1)));
const ANGLE: TransformArg = (v) => isDimension(v, ANGLE_UNIT);
/** Per function, its argument types; an optional tail starts at `min`. */
const TRANSFORM_FUNCTIONS: Readonly<Record<string, { args: readonly TransformArg[]; min?: number }>> = {
    matrix: { args: Array<TransformArg>(6).fill(NUM) },
    matrix3d: { args: Array<TransformArg>(16).fill(NUM) },
    translate: { args: [LEN_PCT, LEN_PCT], min: 1 },
    translatex: { args: [LEN_PCT] },
    translatey: { args: [LEN_PCT] },
    translatez: { args: [LEN] },
    translate3d: { args: [LEN_PCT, LEN_PCT, LEN] },
    scale: { args: [NUM_PCT, NUM_PCT], min: 1 },
    scalex: { args: [NUM_PCT] },
    scaley: { args: [NUM_PCT] },
    scalez: { args: [NUM_PCT] },
    scale3d: { args: [NUM_PCT, NUM_PCT, NUM_PCT] },
    rotate: { args: [ANGLE] },
    rotatex: { args: [ANGLE] },
    rotatey: { args: [ANGLE] },
    rotatez: { args: [ANGLE] },
    rotate3d: { args: [NUM, NUM, NUM, ANGLE] },
    skew: { args: [ANGLE, ANGLE], min: 1 },
    skewx: { args: [ANGLE] },
    skewy: { args: [ANGLE] },
    perspective: { args: [(v) => v.toLowerCase() === 'none' || (LEN(v) && !v.startsWith('-'))] },
};

/** A CSS value with its comments (closed or running to the end) read as whitespace (CSS Syntax 3 §4.3.2). */
const withoutCssComments = (value: string): string => value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');

/** A unitless CSS number without exponent: a sign right after it starts the next number (`0-1` is `0 -1`). */
const BARE_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * The top-level components of a CSS value, comments removed, split as the CSS tokenizer does
 * (CSS Syntax 3 §4.3): at whitespace; after a `%` or a function's closing `)`, which end their token
 * (svgo's csso drops the space there: `scale: 50% 2` → `scale:50%2`, `url(#a) #fff` → `url(#a)#fff`);
 * before a sign that follows a unitless number (`scale: 2 -1` → `scale:2-1`). A top-level comma is a
 * component of its own. A function (`calc(1px + 2px)`) is one component, closed or not.
 */
export function cssComponents(value: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let token = '';
    let ended = false; // the last character ended a token: `%` or a top-level `)`
    const push = (): void => {
        if (token) out.push(token);
        token = '';
    };
    for (const c of withoutCssComments(value)) {
        if (!depth && (ended || c === ',')) push();
        ended = false;
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        if (!depth && /\s/.test(c)) push();
        else if (!depth && c === ',') out.push(c);
        else {
            if (!depth && (c === '-' || c === '+') && BARE_NUMBER.test(token)) push();
            token += c;
            ended = !depth && (c === '%' || c === ')');
        }
    }
    push();
    return out;
}

/**
 * The items of a CSS list separated by whitespace and / or one comma (`stroke-dasharray: 1, 2 3`),
 * split as by {@link cssComponents} (`10%5` is `10% 5`); null for an empty item (`1,,2`, `1,`).
 */
export function cssListItems(value: string): string[] | null {
    const parts = cssComponents(value);
    const items = parts.filter((p) => p !== ',');
    const empty = parts.some((p, i) => p === ',' && (i === 0 || i === parts.length - 1 || parts[i + 1] === ','));
    return empty || !items.length ? null : items;
}

/**
 * The functions of a CSS transform list, lowercase, with their top-level comma-separated arguments
 * (trimmed), or null when the value is not a list of functions. Comments read as whitespace and a
 * function still open at the end of the value is closed, as by CSS Syntax 3 (`rotate(10deg` applies).
 */
function cssTransformFunctions(value: string): { name: string; args: string[] }[] | null {
    const s = withoutCssComments(value);
    const head = /\s*([a-z][a-z0-9]*)\(/iy;
    const out: { name: string; args: string[] }[] = [];
    let i = 0;
    while (s.slice(i).trim()) {
        head.lastIndex = i;
        const m = head.exec(s);
        if (!m) return null;
        const args: string[] = [];
        let depth = 1;
        let start = head.lastIndex;
        let j = start;
        for (; j < s.length && depth; j++) {
            const c = s[j];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (c === ',' && depth === 1) {
                args.push(s.slice(start, j).trim());
                start = j + 1;
            }
        }
        args.push(s.slice(start, depth ? j : j - 1).trim());
        out.push({ name: m[1]!.toLowerCase(), args });
        i = j;
    }
    return out.length ? out : null;
}

/**
 * Whether a CSS `transform` value is valid (CSS Transforms 1 §7, 2 §12): `none` or a list of known
 * functions, each with its count of comma-separated arguments of the right types. A browser drops an
 * invalid declaration (`banana`, `rotate(`, `translate(1px,,2px)`, `translate(1px 2px)`, a unitless
 * nonzero length or angle: only the SVG attribute syntax reads those). Valid values the converter
 * cannot fold (3D functions, percentages, `calc()`…) are valid here: `foldTransform` reports them.
 */
function isCssTransformList(value: string): boolean {
    if (value.toLowerCase() === 'none') return true;
    const functions = cssTransformFunctions(value);
    return (
        !!functions &&
        functions.every(({ name, args }) => {
            const f = TRANSFORM_FUNCTIONS[name];
            return (
                !!f &&
                args.length >= (f.min ?? f.args.length) &&
                args.length <= f.args.length &&
                // An argument holding a function (`calc()`, `min()`…) is left to the browser: valid.
                args.every((a, k) => a.includes('(') || (!/\s/.test(a) && f.args[k]!(a)))
            );
        })
    );
}

/** A valid CSS `transform` list as `parseCssTransform` reads it: comments removed, every function closed. */
export function closedCssTransform(value: string): string {
    const functions = cssTransformFunctions(value);
    return functions ? functions.map(({ name, args }) => `${name}(${args.join(',')})`).join(' ') : value;
}

/**
 * Whether each component of an individual transform has its type; one holding a function (`calc()`…)
 * is left to the browser: valid, as in `isCssTransformList`.
 */
const hasTypes = (parts: readonly string[], types: readonly TransformArg[]): boolean =>
    parts.length === types.length && parts.every((p, k) => p.includes('(') || types[k]!(p));
/** A CSS `<angle>` with its unit: unlike in a transform function, a bare `0` is not one (Chrome drops `rotate: 0`). */
const STRICT_ANGLE: TransformArg = (v) => !CSS_NUMBER.test(v) && ANGLE(v);
const AXIS: TransformArg = (v) => /^[xyz]$/i.test(v);

/**
 * CSS `translate` (CSS Transforms 2 §6.1): `none | <length-percentage> [<length-percentage> <length>?]?`.
 * Chrome 2026-11 (`CSS.supports`) drops `5`, `5px 5px 3`, `5px 5px 5%`, `5px,5px`, `5deg`.
 */
function isCssTranslate(v: string): boolean {
    if (v.toLowerCase() === 'none') return true;
    const parts = cssComponents(v);
    return parts.length >= 1 && parts.length <= 3 && hasTypes(parts, [LEN_PCT, LEN_PCT, LEN].slice(0, parts.length));
}

/**
 * CSS `rotate` (CSS Transforms 2 §6.2): `none | <angle> | [x | y | z | <number>{3}] && <angle>`.
 * Chrome 2026-11 drops `0`, `30`, `z 30`, `30px`, `1 1 30deg`, `z z 30deg`, `1, 1, 0, 30deg`.
 */
function isCssRotate(v: string): boolean {
    if (v.toLowerCase() === 'none') return true;
    const parts = cssComponents(v);
    const [A, N] = [STRICT_ANGLE, NUM];
    return (
        hasTypes(parts, [A]) ||
        hasTypes(parts, [AXIS, A]) ||
        hasTypes(parts, [A, AXIS]) ||
        hasTypes(parts, [N, N, N, A]) ||
        hasTypes(parts, [A, N, N, N])
    );
}

/**
 * CSS `scale` (CSS Transforms 2 §6.3): `none | [<number> | <percentage>]{1,3}`.
 * Chrome 2026-11 drops `2px`, `2deg`, `2,3`, `2 3 4 5`, `banana`.
 */
function isCssScale(v: string): boolean {
    if (v.toLowerCase() === 'none') return true;
    const parts = cssComponents(v);
    return parts.length >= 1 && parts.length <= 3 && parts.every((p) => p.includes('(') || NUM_PCT(p));
}

/** Per property, whether a value (not a CSS-wide keyword, no substitution function) is valid. */
const VALUE_GRAMMARS: Record<string, (value: string) => boolean> = {
    d: isCssPathData,
    display: isDisplay,
    visibility: (v) => isKeywordList(v, keywords('visible', 'hidden', 'collapse'), 1),
    'fill-rule': (v) => isKeywordList(v, keywords('nonzero', 'evenodd'), 1),
    'clip-rule': (v) => isKeywordList(v, keywords('nonzero', 'evenodd'), 1),
    'stroke-linecap': (v) => isKeywordList(v, keywords('butt', 'round', 'square'), 1),
    'stroke-linejoin': (v) => isKeywordList(v, keywords('miter', 'miter-clip', 'round', 'bevel', 'arcs'), 1),
    'stroke-miterlimit': (v) => NUMBER.test(v) && parseFloat(v) >= 0,
    'stroke-width': (v) => isLengthPercentage(v, true),
    'stroke-dashoffset': (v) => isLengthPercentage(v, false),
    'stroke-dasharray': isDashArray,
    opacity: (v) => NUMBER_OR_PERCENTAGE.test(v),
    'fill-opacity': (v) => NUMBER_OR_PERCENTAGE.test(v),
    'stroke-opacity': (v) => NUMBER_OR_PERCENTAGE.test(v),
    'stop-opacity': (v) => NUMBER_OR_PERCENTAGE.test(v),
    'flood-opacity': (v) => NUMBER_OR_PERCENTAGE.test(v),
    fill: (v) => isColor(v, true),
    stroke: (v) => isColor(v, true),
    color: (v) => isColor(v, false),
    'stop-color': (v) => isColor(v, false),
    'flood-color': (v) => isColor(v, false),
    'lighting-color': (v) => isColor(v, false),
    'paint-order': (v) => v.toLowerCase() === 'normal' || isKeywordList(v, keywords('fill', 'stroke', 'markers'), 3),
    overflow: (v) => {
        const words = v.toLowerCase().split(/\s+/); // one value per axis: `hidden hidden` is valid
        return words.length <= 2 && words.every((w) => OVERFLOW.has(w));
    },
    'mask-type': (v) => isKeywordList(v, keywords('luminance', 'alpha'), 1),
    'color-interpolation': (v) => isKeywordList(v, keywords('auto', 'sRGB', 'linearRGB'), 1),
    transform: isCssTransformList,
    translate: isCssTranslate,
    rotate: isCssRotate,
    scale: isCssScale,
    'vector-effect': (v) =>
        v.toLowerCase() === 'none' ||
        isKeywordList(v, keywords('non-scaling-stroke', 'non-scaling-size', 'non-rotation', 'fixed-position'), 4),
};

/**
 * Whether `value` (trimmed, without `!important`) is valid for the CSS property `name`, i.e. whether
 * a browser keeps the declaration (an invalid one is ignored: the previous declaration, then the
 * presentation attribute, then the inherited value applies). Checked for the properties the
 * converter reads (keywords, numbers / percentages, opacities, lengths, colors and paints); any value
 * is valid for another property, for a CSS-wide keyword, and when it holds a substitution function
 * (`var()`, `env()`: checked by the browser at computed-value time). Valid values the converter
 * cannot resolve (`1ex`, `color-mix()`…) are valid here: their readers report them.
 */
export function isValidPropertyValue(name: string, value: string): boolean {
    const grammar = VALUE_GRAMMARS[name.toLowerCase()];
    const v = value.trim();
    if (!grammar || CSS_WIDE_KEYWORDS.has(v.toLowerCase()) || SUBSTITUTION.test(v)) return true;
    return v !== '' && grammar(v);
}

export const isNone = (v: string | undefined): boolean => v === undefined || v.trim().toLowerCase() === 'none';

/**
 * Elements whose own `*Transform` attribute, not `transform`, is the presentation attribute of the
 * CSS `transform` property (CSS Transforms 1, SVG 2): the CSS transform of a gradient is folded into its
 * `gradientTransform` (Chrome renders both alike, `transform-origin` included, in the gradient's
 * user units). A pattern, which the converter does not paint, is left untouched.
 */
const OWN_TRANSFORM_ATTRIBUTE: Readonly<Record<string, string | null>> = {
    linearGradient: 'gradientTransform',
    radialGradient: 'gradientTransform',
    pattern: null,
};
/** CSS Transforms 2 individual transforms, applied in this order before `transform` (§6). */
const INDIVIDUAL_TRANSFORMS = ['translate', 'rotate', 'scale'] as const;
/**
 * Declarations folded into the `transform` attribute (`transform-origin` and `transform-box` also
 * read as attributes).
 */
const TRANSFORM_PROPERTIES = ['transform', 'transform-origin', 'transform-box', ...INDIVIDUAL_TRANSFORMS] as const;
/** `transform-box` values equivalent to SVG's default reference box (the nearest viewport). */
const VIEW_BOX = new Set(['view-box', 'initial', 'unset', 'revert']);
/** `transform-box` values naming a box of the element's geometry (`content-box` / `border-box` map to these). */
const GEOMETRY_BOX = new Set(['fill-box', 'stroke-box', 'content-box', 'border-box']);
/**
 * The geometry boxes of an element that draws nothing (a gradient): empty, at the origin of its user
 * space (Chrome and Firefox render `transform-box: fill-box` there).
 */
const EMPTY_BOX: Viewport = { width: 0, height: 0 };
/** `mix-blend-mode` values that blend nothing. */
const NO_BLEND = new Set(['normal', 'initial', 'unset', 'revert']);
/** Values that reset a non-inherited property whose initial value is `none` (`path-length`, `translate`…). */
const NONE = new Set(['none', 'initial', 'unset', 'revert', 'revert-layer']);
/** Properties a VectorDrawable cannot represent, reported unless `none` (motion path, CSS masks). */
const UNSUPPORTED_UNLESS_NONE = [
    'offset-path',
    'mask-image',
    '-webkit-mask',
    '-webkit-mask-image',
    'mask-border',
    '-webkit-mask-box-image',
    '-webkit-mask-box-image-source',
] as const;

type Warn = (w: Warning) => void;

/** Removes declarations from an element's inline `style` (dropping the attribute once empty). */
function removeDeclarations(attrs: Record<string, string>, names: readonly string[]): void {
    const declarations = Object.entries(parseStyle(attrs.style));
    const kept = declarations.filter(([k]) => !names.includes(k));
    if (kept.length === declarations.length) return; // nothing to remove: keep the author's formatting
    if (kept.length) attrs.style = kept.map(([k, v]) => `${k}:${v}`).join(';');
    else delete attrs.style;
}

/** The unit vector of a `rotate` axis keyword. */
const AXES: Record<string, readonly [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * The matrix of a CSS `rotate` value, as its components: `<angle>`, an axis keyword (`x`, `y`, `z`)
 * or three numbers, before or after the angle. A rotation around `(0, 0, k)` is a 2D rotation
 * (opposite for k < 0) and a null angle the identity on any axis; null for any other rotation.
 */
function rotation(parts: readonly string[]): Matrix | null {
    let angle: string | undefined;
    let axis: readonly number[] | undefined = AXES.z;
    if (parts.length === 1) angle = parts[0];
    else if (parts.length === 2) {
        const k = AXES[parts[0]!] ? 0 : 1;
        [axis, angle] = [AXES[parts[k]!], parts[1 - k]];
    } else if (parts.length === 4) {
        const k = CSS_NUMBER.test(parts[0]!) ? 3 : 0;
        angle = parts[k];
        axis = parts.filter((_, i) => i !== k).map(Number);
    }
    const m = angle === undefined ? null : parseCssTransform(`rotate(${angle})`);
    if (!m || !axis || axis.some(Number.isNaN)) return null;
    if (isIdentity(m)) return IDENTITY;
    const [x, y, z] = axis as [number, number, number];
    if (x !== 0 || y !== 0 || z === 0) return null;
    return z > 0 ? m : { ...m, b: -m.b, c: -m.c };
}

/**
 * The matrix of an individual transform property (CSS Transforms 2 §6: `translate: <x> [<y> [<z>]]`,
 * `rotate: [<axis>] <angle>`, `scale: <sx> [<sy> [<sz>]]`), `none` being the identity. Null when it
 * is not a 2D transform with absolute units (a percentage, `calc()`, a nonzero rotation around an
 * axis other than ±z, a nonzero z translation or a z scale other than 1). Comments are whitespace.
 */
function individualTransform(name: (typeof INDIVIDUAL_TRANSFORMS)[number], value: string): Matrix | null {
    const v = withoutCssComments(value).trim().toLowerCase();
    if (NONE.has(v)) return IDENTITY;
    if (/[(),]/.test(v)) return null;
    const parts = cssComponents(v);
    if (name === 'rotate') return rotation(parts);
    if (parts.length === 3) {
        const z = parts.pop()!;
        if (name === 'translate' ? parseLength(z) !== 0 : parseCssTransform(`scale(${z})`)?.a !== 1) return null;
    }
    return parts.length <= 2 ? parseCssTransform(`${name}(${parts.join(',')})`) : null;
}

/**
 * Folds the CSS `transform` property and `transform-origin` (CSS or attribute) of a non-root element
 * into its `target` attribute (`transform`, or a gradient's `gradientTransform`), which is all the
 * rest of the converter reads. The CSS property overrides the attribute; the origin applies to
 * either, on the reference box of `transform-box`: the nearest SVG viewport (`view-box`, the
 * default: its viewBox size, at the user-space origin), passed as `viewport` when known; on a
 * gradient, which draws nothing, a geometry box (`fill-box`…) is empty at the origin. What no matrix
 * can express (a percentage or keyword of an unknown viewport or of the element bounding box, 3D) is
 * reported and the element left as it was, i.e. the CSS ignored. An invalid declaration (`translate(5)`,
 * `banana`: see `isCssTransformList`) is dropped silently by `parseStyle`, as by a browser.
 */
function foldTransform(
    el: XastElement,
    name: string,
    warn: Warn,
    target = 'transform',
    viewport: Viewport | undefined = undefined,
): void {
    const attrs = el.attributes!;
    const css = parseStyle(attrs.style);
    const cssTransform = css.transform;
    const origin = css['transform-origin'] ?? attrs['transform-origin'];
    const box = css['transform-box'] ?? attrs['transform-box'];
    const individuals = INDIVIDUAL_TRANSFORMS.filter((p) => css[p] !== undefined);
    if (cssTransform === undefined && origin === undefined && box === undefined && !individuals.length) return;
    const ignored = (what: string, why: string): void =>
        warn({ code: 'unsupported-style', message: `${what} on <${name}> ${why}; ignored.`, node: name });

    let matrix: Matrix | null = parseTransform(attrs[target]);
    if (cssTransform !== undefined) {
        matrix = parseCssTransform(closedCssTransform(cssTransform));
        if (!matrix) return ignored(`transform: ${cssTransform}`, 'is not a 2D transform with absolute units');
    }
    // translate · rotate · scale · transform, all around the origin (CSS Transforms 2 §6).
    let individual = IDENTITY;
    for (const p of individuals) {
        const m = individualTransform(p, css[p]!);
        if (m) individual = multiply(individual, m);
        else ignored(`${p}: ${css[p]}`, 'is not a 2D transform with absolute units');
    }
    if (!isIdentity(individual)) matrix = multiply(individual, matrix ?? IDENTITY);
    if (matrix && !isIdentity(matrix)) {
        const b = box?.trim().toLowerCase();
        const geometryBox = b !== undefined && !VIEW_BOX.has(b);
        if (geometryBox && !(target !== 'transform' && GEOMETRY_BOX.has(b)))
            return ignored(`transform-box: ${box}`, 'needs the element bounding box (only view-box is supported)');
        const ref = geometryBox ? EMPTY_BOX : viewport;
        // Split as the CSS tokenizer does: svgo writes `transform-origin: 50% 0` as `50%0`.
        const o = origin === undefined ? { x: 0, y: 0 } : parseTransformOrigin(cssComponents(origin).join(' '), ref);
        if (!o)
            return ignored(
                `transform-origin: ${origin}`,
                ref ? 'cannot be resolved' : 'needs the reference box (only absolute lengths)',
            );
        if (cssTransform !== undefined || !isIdentity(individual) || o.x !== 0 || o.y !== 0)
            attrs[target] = formatMatrix(aroundOrigin(matrix, o.x, o.y));
    } else if (cssTransform !== undefined) delete attrs[target]; // `transform: none` overrides the attribute
    removeDeclarations(attrs, TRANSFORM_PROPERTIES);
    delete attrs['transform-origin'];
    delete attrs['transform-box'];
}

/**
 * Containers whose content is not rendered in place: only a reference (`<use>`, `url(#…)`, a
 * gradient `href`) instantiates it.
 */
const NOT_RENDERED_IN_PLACE = new Set([
    'defs',
    'symbol',
    'clipPath',
    'mask',
    'linearGradient',
    'radialGradient',
    'pattern',
    'marker',
    'filter',
    'hatch',
]);
/** `url(#id)` references of an attribute or style value (paint, clip-path, mask, filter, marker…). */
const URL_REFERENCE = /url\(\s*['"]?#([^'")\s]+)/g;

/**
 * The elements a render may draw or use: the document outside the containers of
 * {@link NOT_RENDERED_IN_PLACE}, plus every subtree a reachable element references (a `<use>` or
 * gradient `href`, any `url(#id)`), transitively. A link (`<a href>`) instantiates nothing.
 * Content the renderer skips is left out with its subtree, and so are its references: a child
 * `isNotRendered` excludes (`display: none`, failing conditions, foreign or metadata elements), and
 * every child of a `<switch>` but the one `switchChild` picks. A referenced resource is kept whatever
 * its own conditions or `display` (see `failsConditions`). A `<path>` excluded only by its CSS `d`
 * (`isNotRenderedButForPathData` keeps it) draws nothing either: only that `d` is reported
 * (`pathDataOnly`), the reason it is not drawn.
 */
function renderedElements(root: XastElement): { rendered: Set<XastElement>; pathDataOnly: Set<XastElement> } {
    const foreign = foreignElements(root);
    const byId = new Map<string, XastElement>();
    const index = (el: XastElement): void => {
        const id = el.attributes?.id;
        if (id !== undefined && !byId.has(id)) byId.set(id, el);
        for (const child of el.children ?? []) if (child.type === 'element' && child.name) index(child);
    };
    index(root);
    const rendered = new Set<XastElement>();
    const pathDataOnly = new Set<XastElement>();
    const pending: XastElement[] = [root];
    const reference = (id: string): void => {
        const target = byId.get(id);
        if (target && !rendered.has(target)) pending.push(target);
    };
    const mark = (el: XastElement): void => {
        if (rendered.has(el)) return;
        rendered.add(el);
        const attrs = el.attributes ?? {};
        for (const [attr, value] of Object.entries(attrs)) {
            if ((attr === 'href' || attr === 'xlink:href') && el.name !== 'a' && value.trim().startsWith('#'))
                reference(value.trim().slice(1));
            for (const m of value.matchAll(URL_REFERENCE)) reference(m[1]!);
        }
        const picked = el.name === 'switch' ? switchChild(el, foreign).child : undefined;
        for (const child of el.children ?? []) {
            if (child.type !== 'element' || !child.name || NOT_RENDERED_IN_PLACE.has(child.name)) continue;
            if (el.name === 'switch' && child !== picked) continue;
            if (!isNotRendered(child, foreign)) mark(child);
            else if (child.name === 'path' && !isNotRenderedButForPathData(child, foreign)) pathDataOnly.add(child); // excluded by its CSS `d` alone
        }
    };
    for (let el = pending.pop(); el; el = pending.pop()) mark(el);
    return { rendered, pathDataOnly };
}

/** Elements whose content is laid out in a viewport of their own, known only where they are instantiated. */
const INSTANTIATED_VIEWPORT = new Set(['symbol', 'marker', 'pattern']);

/**
 * The SVG viewport the children of `el` resolve `transform-box: view-box` against (CSS Transforms 1
 * §5: the viewBox size, else the viewport size), given the one `el` itself sits in. Undefined when
 * not known here: an unsized root (no viewBox, no width / height), a nested `<svg>` in an unknown
 * one, the content of a `<symbol>`, `<marker>` or `<pattern>` (laid out where it is used).
 */
function contentViewport(el: XastElement, outermost: boolean, vp: Viewport | undefined): Viewport | undefined {
    const attrs = el.attributes ?? {};
    if (outermost) {
        if (disablingViewBox(attrs) !== undefined) return undefined;
        const layout = rootLayout(attrs);
        return layout.assumed.length ? undefined : layout.viewBox;
    }
    if (el.name === 'svg') return vp && nestedLayout(el, vp)?.viewport;
    return INSTANTIATED_VIEWPORT.has(el.name!) ? undefined : vp;
}

/**
 * Applies, or reports, the CSS properties the rest of the converter does not read: `transform`,
 * `transform-origin` and `transform-box` are folded into `transform` attributes (a gradient's
 * `gradientTransform`; see `foldTransform`), and so are `translate`, `rotate` and `scale`; a
 * `mix-blend-mode` other than `normal`, a CSS `path-length`, an `offset-path`, a CSS mask (image,
 * border, `-webkit-mask*`) and a CSS `d` the converter cannot resolve (`var()`, `inherit`…) are
 * reported (`unsupported-style`).
 * Mutates the tree; run it before `<use>` expansion, so that clones inherit the folded attributes.
 * Transforms are folded on the whole tree, but only rendered elements are reported (see
 * `renderedElements`): a definition no reference instantiates draws nothing, and an instantiated one
 * is reported once, whatever the number of its `<use>` clones.
 * The transform of the root `<svg>` (attribute or CSS) is left to the root layout: `rootTransform` /
 * `rootOrigin` (`src/viewport.ts`) apply it, and `layoutWarnings` reports what they cannot resolve;
 * only its individual transforms (`translate`, `rotate`, `scale`), which they do not read, are
 * reported here.
 */
export function applyCssProperties(root: XastElement, report: Warn): void {
    const { rendered, pathDataOnly } = renderedElements(root);
    const silent: Warn = () => undefined;
    const visit = (el: XastElement, outermost: boolean, viewport: Viewport | undefined): void => {
        const name = el.name!;
        const warn = rendered.has(el) ? report : silent;
        const warnPathData = rendered.has(el) || pathDataOnly.has(el) ? report : silent;
        const attrs = (el.attributes ??= {});
        const style = parseStyle(attrs.style);
        const blend = style['mix-blend-mode']?.trim().toLowerCase();
        if (blend !== undefined && !NO_BLEND.has(blend) && name !== 'tspan' && name !== 'textPath')
            warn({
                code: 'unsupported-style',
                message: `mix-blend-mode: ${blend} on <${name}> cannot be represented in a VectorDrawable; ignored.`,
                node: name,
            });
        // CSS `path-length` (tentative, not the pathLength attribute) rescales the dash pattern.
        const pathLength = style['path-length']?.trim().toLowerCase();
        if (pathLength !== undefined && !NONE.has(pathLength))
            warn({
                code: 'unsupported-style',
                message: `path-length: ${pathLength} on <${name}> is not supported (only the pathLength attribute); ignored.`,
                node: name,
            });
        // The geometry reader skips such a `<path>` (`isNotRendered`): this is its only warning.
        const d = name === 'path' ? style.d?.trim() : undefined;
        if (d !== undefined && UNRESOLVED_CSS_PATH_DATA.test(d))
            warnPathData({
                code: 'unsupported-style',
                message: `d: ${d} on <path> cannot be resolved; the path is not drawn.`,
                node: name,
            });
        for (const p of UNSUPPORTED_UNLESS_NONE) {
            const value = style[p]?.trim();
            if (value !== undefined && !NONE.has(value.toLowerCase()))
                warn({
                    code: 'unsupported-style',
                    message: `${p}: ${value} on <${name}> cannot be represented in a VectorDrawable; ignored.`,
                    node: name,
                });
        }
        // The root <svg> transform is the root layout's business (its default origin is its box centre),
        // which does not read the individual transforms.
        if (outermost) {
            for (const p of INDIVIDUAL_TRANSFORMS)
                if (style[p] !== undefined && !NONE.has(style[p].trim().toLowerCase()))
                    warn({
                        code: 'unsupported-style',
                        message: `${p}: ${style[p]} on the root <svg> is not supported; ignored.`,
                        node: name,
                    });
        } else {
            const target = Object.hasOwn(OWN_TRANSFORM_ATTRIBUTE, name) ? OWN_TRANSFORM_ATTRIBUTE[name] : 'transform';
            if (target) foldTransform(el, name, warn, target, viewport);
        }
        const inner = contentViewport(el, outermost, viewport);
        for (const child of el.children ?? []) if (child.type === 'element' && child.name) visit(child, false, inner);
    };
    for (const child of root.children ?? [])
        if (child.type === 'element' && child.name)
            visit(child, root.type === 'root' && child.name === 'svg', undefined);
}
