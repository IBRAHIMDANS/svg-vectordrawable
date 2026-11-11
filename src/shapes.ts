import { styleDeclarations } from './style.js';
import { parseLength } from './units.js';

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
const IMPORTANT = /\s*!\s*important\s*$/i;

/**
 * The value a geometry declaration computes to, as an attribute value the switch below reads, or
 * undefined when the declaration is invalid (CSS then drops it and the attribute applies). Lengths
 * the converter cannot resolve (`ex`, `ch`, `calc()`…) count as invalid.
 */
function cssGeometryValue(name: string, kind: GeometryKind, raw: string): string | undefined {
    const value = raw.replace(IMPORTANT, '').trim();
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
 * Applies the geometry properties of the inline `style` over the attributes of the same name: in
 * SVG 2 they are CSS properties, so a valid declaration wins over the attribute (the last valid one
 * when repeated). svgo inlines `<style>` rules into `style` first when optimizing.
 */
function withCssGeometry(name: string, attrs: Attrs): Attrs {
    const properties = GEOMETRY_PROPERTIES[name];
    if (!properties || !attrs.style) return attrs;
    let resolved: Attrs | undefined;
    for (const [key, raw] of styleDeclarations(attrs.style)) {
        const kind = properties[key];
        const value = kind && cssGeometryValue(name, kind, raw);
        if (value !== undefined) (resolved ??= { ...attrs })[key] = value;
    }
    return resolved ?? attrs;
}

export function shapeToPathData(name: string, ownAttrs: Attrs, options: ShapeOptions = {}): string | null {
    const attrs = withCssGeometry(name, ownAttrs);
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
    switch (name) {
        case 'rect': {
            const w = n('width', 'x');
            const h = n('height', 'y');
            if (w <= 0 || h <= 0) return null;
            const x = n('x', 'x');
            const y = n('y', 'y');
            // SVG 2 used radii: a missing, `auto`, negative or unparsable radius is `auto` and takes
            // the other radius (both `auto` → square corners); each is then clamped to half the side.
            const radius = (key: string, axis: 'x' | 'y'): number | undefined => {
                const v = parseLength(attrs[key], axis === 'x' ? viewport?.width : viewport?.height);
                return v >= 0 ? v : undefined;
            };
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
            const radius = (key: string, axis: 'x' | 'y'): number | undefined =>
                attrs[key]?.trim().toLowerCase() === 'auto' ? undefined : n(key, axis);
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
            const pts = (attrs.points ?? '')
                .trim()
                .split(/[\s,]+/)
                .map(Number)
                .filter((v) => !Number.isNaN(v));
            if (pts.length < 4) return null;
            let d = `M${pts[0]},${pts[1]}`;
            for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]},${pts[i + 1]}`;
            return name === 'polygon' ? d + 'z' : d;
        }
        default:
            return null;
    }
}

export const SHAPE_NAMES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
