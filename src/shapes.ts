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

export function shapeToPathData(name: string, attrs: Attrs, options: ShapeOptions = {}): string | null {
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
            let rx = attrs.rx !== undefined ? n('rx', 'x') : n('ry', 'y');
            let ry = attrs.ry !== undefined ? n('ry', 'y') : n('rx', 'x');
            rx = Math.min(Math.max(rx, 0), w / 2);
            ry = Math.min(Math.max(ry, 0), h / 2);
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
            const rx = n('rx', 'x');
            const ry = n('ry', 'y');
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
