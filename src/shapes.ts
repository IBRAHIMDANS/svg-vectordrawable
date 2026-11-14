import { isUnresolvableCssLength, styleDeclarations } from './style.js';
import { inFloatRange, parseLength } from './units.js';

type Attrs = Record<string, string>;

/** Size of the viewport (viewBox units) that percentage shape attributes resolve against. */
export interface ShapeViewport {
    width: number;
    height: number;
}

export interface ShapeOptions {
    /** Reference for `%` values; without it, percentages fall back to their attribute default. */
    viewport?: ShapeViewport;
    /** Decimal places kept for generated numbers. @default 3 */
    precision?: number;
}

/**
 * SVG 2 geometry properties of each shape, with their CSS grammar: `position` is any
 * `<length-percentage>`, `size` a non-negative one (or `auto` for a rect's width / height, which
 * computes to 0), `radius` a non-negative one or `auto`.
 */
type GeometryKind = 'position' | 'size' | 'radius';
const GEOMETRY_PROPERTIES: Record<string, Record<string, GeometryKind>> = {
    rect: { x: 'position', y: 'position', width: 'size', height: 'size', rx: 'radius', ry: 'radius' },
    circle: { cx: 'position', cy: 'position', r: 'size' },
    ellipse: { cx: 'position', cy: 'position', rx: 'radius', ry: 'radius' },
};
/** CSS-wide keywords that resolve to the initial value here (geometry properties are not inherited). */
const INITIAL_KEYWORDS = new Set(['initial', 'unset', 'revert', 'revert-layer']);

/**
 * The value a geometry declaration computes to, as an attribute value the switch below reads, or
 * undefined when the declaration is invalid (CSS then drops it and the attribute applies). Lengths
 * the converter cannot resolve (`ex`, `ch`, `calc()`…) count as invalid here; {@link
 * unresolvedShapeLengths} reports them.
 */
function cssGeometryValue(name: string, kind: GeometryKind, value: string): string | undefined {
    const keyword = value.toLowerCase();
    if (INITIAL_KEYWORDS.has(keyword)) return kind === 'radius' ? 'auto' : '0';
    if (keyword === 'auto') {
        if (kind === 'radius') return 'auto';
        if (name === 'rect' && kind === 'size') return '0';
        return undefined;
    }
    const length = parseLength(value, 1); // any reference: only validity matters here
    if (Number.isNaN(length) || (kind !== 'position' && length < 0)) return undefined;
    return value;
}

/**
 * Per geometry property of the inline `style`, the declaration that applies among those `accepted`:
 * the last `!important` one, else the last one (CSS Cascade §6.4, within one declaration block).
 */
function winningDeclarations(
    name: string,
    attrs: Attrs,
    accepted: (kind: GeometryKind, value: string) => boolean,
): Map<string, string> {
    const properties = GEOMETRY_PROPERTIES[name];
    const out = new Map<string, string>();
    if (!properties || !attrs.style) return out;
    const important = new Set<string>();
    for (const [key, value, isImportant] of styleDeclarations(attrs.style)) {
        const kind = properties[key];
        if (!kind || !accepted(kind, value)) continue;
        if (isImportant) important.add(key);
        else if (important.has(key)) continue;
        out.set(key, value);
    }
    return out;
}

/** Whether a declaration is valid CSS but its length cannot be resolved here (see {@link isUnresolvableCssLength}). */
const unresolvable = (kind: GeometryKind, value: string): boolean =>
    isUnresolvableCssLength(value, kind !== 'position');

/**
 * The geometry declarations of the inline `style` a browser would apply but the converter cannot
 * resolve, so the attribute (or a valid earlier declaration) applies instead: per property, the
 * declaration that wins the cascade when it is one of those.
 */
function unresolvedCssGeometry(name: string, attrs: Attrs): Map<string, string> {
    const winners = winningDeclarations(
        name,
        attrs,
        (kind, value) => cssGeometryValue(name, kind, value) !== undefined || unresolvable(kind, value),
    );
    const properties = GEOMETRY_PROPERTIES[name]!;
    for (const [key, value] of winners) if (!unresolvable(properties[key]!, value)) winners.delete(key);
    return winners;
}

/**
 * Applies the geometry properties of the inline `style` over the attributes of the same name: in
 * SVG 2 they are CSS properties, so a valid declaration wins over the attribute (when repeated, the
 * last valid `!important` one, else the last valid one). svgo inlines `<style>` rules into `style`
 * first when optimizing.
 */
function withCssGeometry(name: string, attrs: Attrs): Attrs {
    const properties = GEOMETRY_PROPERTIES[name];
    if (!properties || !attrs.style) return attrs;
    const winners = winningDeclarations(
        name,
        attrs,
        (kind, value) => cssGeometryValue(name, kind, value) !== undefined,
    );
    if (!winners.size) return attrs;
    const resolved = { ...attrs };
    for (const [key, value] of winners) resolved[key] = cssGeometryValue(name, properties[key]!, value)!;
    return resolved;
}

/**
 * Path data of a basic shape, or null when it draws nothing. A shape whose geometry (a length, or a
 * coordinate derived from them) leaves the float range is not drawn, as in Firefox (Chrome clamps it).
 */
export function shapeToPathData(name: string, ownAttrs: Attrs, options: ShapeOptions = {}): string | null {
    const d = shapePathData(name, withCssGeometry(name, ownAttrs), options);
    return d !== null && pathNumbersInFloatRange(d) ? d : null;
}

/** Whether every number of the path data written by {@link shapePathData} fits in a float. */
const pathNumbersInFloatRange = (d: string): boolean =>
    !/Infinity|NaN/.test(d) && (d.match(/[-+]?[\d.]+(?:e[-+]?\d+)?/gi) ?? []).every((v) => inFloatRange(Number(v)));

function shapePathData(name: string, attrs: Attrs, options: ShapeOptions): string | null {
    const { viewport, precision = 3 } = options;
    const f = 10 ** precision;
    /** Rounds away float noise (`0.49999999999999994`); integers print unchanged. */
    const fmt = (v: number): string => String(Math.round(v * f) / f || 0);
    /** Path data template whose interpolated numbers are rounded. */
    const p = (strings: TemplateStringsArray, ...values: number[]): string =>
        strings.reduce((acc, str, i) => acc + str + (i < values.length ? fmt(values[i]!) : ''), '');
    const diagonal = viewport ? Math.sqrt((viewport.width ** 2 + viewport.height ** 2) / 2) : undefined;
    /** Reads a length; `axis` picks the percentage reference (x: width, y: height, d: diagonal). */
    const n = (key: string, axis: 'x' | 'y' | 'd'): number => {
        const ref = axis === 'x' ? viewport?.width : axis === 'y' ? viewport?.height : diagonal;
        const parsed = parseLength(attrs[key], ref);
        return Number.isNaN(parsed) ? 0 : parsed;
    };
    /**
     * Reads an `rx` / `ry`; undefined for `auto` (SVG 2): a missing, `auto`, negative or unparsable
     * radius, which takes the other one.
     */
    const radius = (key: string, axis: 'x' | 'y'): number | undefined => {
        const v = parseLength(attrs[key], axis === 'x' ? viewport?.width : viewport?.height);
        return v >= 0 ? v : undefined;
    };
    switch (name) {
        case 'rect': {
            const w = n('width', 'x');
            const h = n('height', 'y');
            if (w <= 0 || h <= 0) return null;
            const x = n('x', 'x');
            const y = n('y', 'y');
            // SVG 2 used radii: an `auto` radius takes the other one (both `auto` → square corners);
            // each is then clamped to half the side.
            const rxUsed = radius('rx', 'x');
            const ryUsed = radius('ry', 'y');
            const rx = Math.min(rxUsed ?? ryUsed ?? 0, w / 2);
            const ry = Math.min(ryUsed ?? rxUsed ?? 0, h / 2);
            if (rx > 0 || ry > 0) {
                return (
                    p`M${x + rx},${y}h${w - 2 * rx}a${rx},${ry} 0 0 1 ${rx},${ry}` +
                    p`v${h - 2 * ry}a${rx},${ry} 0 0 1 ${-rx},${ry}h${-(w - 2 * rx)}` +
                    p`a${rx},${ry} 0 0 1 ${-rx},${-ry}v${-(h - 2 * ry)}a${rx},${ry} 0 0 1 ${rx},${-ry}z`
                );
            }
            return p`M${x},${y}h${w}v${h}h${-w}z`;
        }
        case 'circle': {
            const r = n('r', 'd');
            if (r <= 0) return null;
            const cx = n('cx', 'x');
            const cy = n('cy', 'y');
            return p`M${cx - r},${cy}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0z`;
        }
        case 'ellipse': {
            // An `auto` radius takes the other one (both `auto` → 0, not rendered).
            const rxUsed = radius('rx', 'x');
            const ryUsed = radius('ry', 'y');
            const rx = rxUsed ?? ryUsed ?? 0;
            const ry = ryUsed ?? rxUsed ?? 0;
            if (rx <= 0 || ry <= 0) return null;
            const cx = n('cx', 'x');
            const cy = n('cy', 'y');
            return p`M${cx - rx},${cy}a${rx},${ry} 0 1 0 ${2 * rx},0a${rx},${ry} 0 1 0 ${-2 * rx},0z`;
        }
        case 'line':
            return p`M${n('x1', 'x')},${n('y1', 'y')}L${n('x2', 'x')},${n('y2', 'y')}`;
        case 'polyline':
        case 'polygon': {
            const pts = parsePoints(attrs.points ?? '');
            if (pts.length < 4) return null;
            let d = `M${pts[0]},${pts[1]}`;
            for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]},${pts[i + 1]}`;
            return name === 'polygon' ? d + 'z' : d;
        }
        default:
            return null;
    }
}

const SVG_WSP = '[ \\t\\r\\n]';
/** A whole SVG number: digits are required on both sides of the dot and in the exponent. */
const POINTS_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;
const POINTS_SEPARATOR = new RegExp(`${SVG_WSP}*,${SVG_WSP}*|${SVG_WSP}+`);
const POINTS_TRIM = new RegExp(`^${SVG_WSP}+|${SVG_WSP}+$`, 'g');

/**
 * The coordinates a `points` list draws, [x0, y0, x1, y1, …], read as Firefox does (verified in
 * Firefox and Chrome on 2026-11-14). Unlike SVG 2 §10.10 ("rendered up to the error"), a list in error
 * draws nothing: a token that is not a whole number (`x`, `10px`, `10.`, `NaN`), an empty token
 * (leading, trailing or doubled comma), or a number a float cannot hold. An odd trailing coordinate
 * is ignored. As in Firefox, an x token may hold its y after a minus sign (`10-5` → 10, -5), a y token
 * may not (Chrome is more lenient: `.1.5`, `10+5`, a trailing comma).
 */
export function parsePoints(value: string): number[] {
    const text = value.replace(POINTS_TRIM, '');
    if (text === '') return [];
    const tokens = text.split(POINTS_SEPARATOR);
    /** The token as a number when it is a whole number within the float range, else NaN. */
    const whole = (token: string): number => {
        const v = POINTS_NUMBER.exec(token)?.[0] === token ? Number(token) : NaN;
        return inFloatRange(v) ? v : NaN;
    };
    const coords: number[] = [];
    for (let i = 0; i < tokens.length;) {
        const token = tokens[i++]!;
        const head = POINTS_NUMBER.exec(token)?.[0];
        if (head === undefined) return [];
        const x = whole(head);
        const rest = token.slice(head.length);
        if (Number.isNaN(x) || (rest !== '' && !rest.startsWith('-'))) return [];
        if (rest === '' && i === tokens.length) break; // odd trailing coordinate
        const y = whole(rest === '' ? tokens[i++]! : rest);
        if (Number.isNaN(y)) return [];
        coords.push(x, y);
    }
    return coords;
}

/** Length attributes of each shape, with the axis their percentages resolve against (d: diagonal). */
const SHAPE_LENGTHS: Record<string, Record<string, 'x' | 'y' | 'd'>> = {
    rect: { x: 'x', y: 'y', width: 'x', height: 'y', rx: 'x', ry: 'y' },
    circle: { cx: 'x', cy: 'y', r: 'd' },
    ellipse: { cx: 'x', cy: 'y', rx: 'x', ry: 'y' },
    line: { x1: 'x', y1: 'y', x2: 'x', y2: 'y' },
};

/**
 * The length attributes of a shape that are set but cannot be resolved (`ex`, `ch`, garbage…), as
 * {@link shapeToPathData} reads them (a valid CSS geometry property wins), with the value used
 * instead: `auto` for a radius (SVG 2), else 0. The keyword `auto` is resolved, never listed. A CSS
 * geometry declaration a browser would apply but the converter cannot resolve (`rx:1ex`,
 * `width:calc(…)`) is listed in place of its attribute, with the attribute value as the one used.
 */
export function unresolvedShapeLengths(
    name: string,
    ownAttrs: Attrs,
    viewport: ShapeViewport,
): { attr: string; value: string; fallback: string }[] {
    const attrs = withCssGeometry(name, ownAttrs);
    const diagonal = Math.sqrt((viewport.width ** 2 + viewport.height ** 2) / 2);
    const refs = { x: viewport.width, y: viewport.height, d: diagonal };
    const css = unresolvedCssGeometry(name, ownAttrs);
    return Object.entries(SHAPE_LENGTHS[name] ?? {}).flatMap(([attr, axis]) => {
        const value = attrs[attr]?.trim();
        const fallback = attr === 'rx' || attr === 'ry' ? 'auto' : '0';
        const resolved = value !== undefined && (value === 'auto' || !Number.isNaN(parseLength(value, refs[axis])));
        const cssValue = css.get(attr);
        if (cssValue !== undefined) return [{ attr, value: cssValue, fallback: resolved ? value : fallback }];
        if (value === undefined || value === '' || resolved) return [];
        return [{ attr, value, fallback }];
    });
}

export const SHAPE_NAMES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
