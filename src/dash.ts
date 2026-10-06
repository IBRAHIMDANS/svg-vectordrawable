import { formatNumber } from './format.js';
import { transformPathData } from './pathData.js';
import { IDENTITY } from './transform.js';
import { parseLength } from './units.js';

/**
 * Bakes `stroke-dasharray` / `stroke-dashoffset` into path geometry. VectorDrawable has no dash
 * support, but a dashed stroke is exactly the stroke of a set of open sub-paths (one per dash).
 *
 * Semantics (SVG 2 §13.5.4 "Computing the stroke shape", same as Skia's dash path effect):
 * - the pattern restarts at the beginning of every subpath (offset included);
 * - a closed subpath includes its closing segment; when a dash runs over the start point of a
 *   closed subpath, its two halves are emitted as one sub-path so the corner gets a line join;
 * - a zero-length dash yields a zero-length segment (`M p L p`), which Android/Skia caps as a
 *   dot with round/square caps (and draws nothing with butt caps, as SVG does).
 *
 * Lines are cut exactly. Quadratic and cubic Béziers (arcs are lowered to cubics first) are cut at
 * arc-length parameters and emitted as exact De Casteljau sub-curves, so the output stays compact
 * and smooth: only the *position* of a cut is approximated. Arc length is measured by adaptive
 * subdivision until, for each piece, control polygon length − chord length ≤ `tolerance`, and the
 * piece length is Gravesen's estimate `(2·chord + (n−1)·polygon) / (n+1)`, whose error is a small
 * fraction of that bound.
 */

/** Above this many dashes for one path, dashing gives up (null) rather than emit huge pathData. */
export const MAX_DASHES = 10_000;

/** Max subdivision depth of a curve when measuring its arc length (2^16 pieces). */
const MAX_DEPTH = 16;

type Point = [number, number];

interface Segment {
    /** Start point then control points then end point (2 for a line, 3 for a quad, 4 for a cubic). */
    pts: Point[];
    length: number;
    /** Curves only: parameters and cumulative lengths of the flattening pieces (both start at 0). */
    ts?: number[];
    ss?: number[];
}

interface Subpath {
    start: Point;
    segments: Segment[];
    closed: boolean;
    length: number;
}

const dist = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Splits a Bézier of any degree at `t` (De Casteljau): [left, right]. */
function splitAt(pts: Point[], t: number): [Point[], Point[]] {
    const left: Point[] = [];
    const right: Point[] = [];
    let level = pts;
    while (level.length) {
        left.push(level[0]!);
        right.unshift(level[level.length - 1]!);
        const next: Point[] = [];
        for (let i = 0; i + 1 < level.length; i++) {
            const [ax, ay] = level[i]!;
            const [bx, by] = level[i + 1]!;
            next.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
        }
        level = next;
    }
    return [left, right];
}

/** Control points of the part of a Bézier between parameters t0 ≤ t1. */
function subCurve(pts: Point[], t0: number, t1: number): Point[] {
    let c = t1 < 1 ? splitAt(pts, t1)[0] : pts;
    if (t0 > 0) c = t1 > 0 ? splitAt(c, t0 / t1)[1] : c.map(() => c[0]!);
    return c;
}

/** Appends the flattening pieces of a curve on [t0, t1] as (t, length) pairs. */
function measure(pts: Point[], t0: number, t1: number, tolerance: number, depth: number, out: number[]): void {
    const chord = dist(pts[0]!, pts[pts.length - 1]!);
    let poly = 0;
    for (let i = 0; i + 1 < pts.length; i++) poly += dist(pts[i]!, pts[i + 1]!);
    if (poly - chord <= tolerance || depth >= MAX_DEPTH) {
        const n = pts.length - 1;
        out.push(t1, (2 * chord + (n - 1) * poly) / (n + 1));
        return;
    }
    const [left, right] = splitAt(pts, 0.5);
    const mid = (t0 + t1) / 2;
    measure(left, t0, mid, tolerance, depth + 1, out);
    measure(right, mid, t1, tolerance, depth + 1, out);
}

function makeSegment(pts: Point[], tolerance: number): Segment {
    if (pts.length === 2) return { pts, length: dist(pts[0]!, pts[1]!) };
    const pairs: number[] = [];
    measure(pts, 0, 1, tolerance, 0, pairs);
    const ts = [0];
    const ss = [0];
    for (let i = 0; i < pairs.length; i += 2) {
        ts.push(pairs[i]!);
        ss.push(ss[ss.length - 1]! + pairs[i + 1]!);
    }
    return { pts, length: ss[ss.length - 1]!, ts, ss };
}

/** Curve parameter at arc length `s` from the segment start (linear within a flattening piece). */
function paramAt(seg: Segment, s: number): number {
    const { ts, ss } = seg;
    if (s <= 0 || seg.length === 0) return 0;
    if (s >= seg.length) return 1;
    if (!ts || !ss) return s / seg.length;
    let lo = 1;
    let hi = ss.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ss[mid]! < s) lo = mid + 1;
        else hi = mid;
    }
    const s0 = ss[lo - 1]!;
    const s1 = ss[lo]!;
    const t0 = ts[lo - 1]!;
    return s1 > s0 ? t0 + ((s - s0) / (s1 - s0)) * (ts[lo]! - t0) : t0;
}

/** Splits a path into subpaths of line / quad / cubic segments, in absolute coordinates. */
function parseSubpaths(d: string, tolerance: number): Subpath[] {
    // transformPathData lowers everything to absolute M/L/C/Q/Z with plain decimal numbers.
    const tokens = transformPathData(d, IDENTITY).match(/[MLCQZ]|-?\d*\.?\d+/g) ?? [];
    const subpaths: Subpath[] = [];
    let current: Subpath | null = null;
    let pen: Point = [0, 0];
    let i = 0;
    const num = (): number => Number(tokens[i++]);
    const open = (): Subpath => {
        if (!current) {
            current = { start: pen, segments: [], closed: false, length: 0 };
            subpaths.push(current);
        }
        return current;
    };
    while (i < tokens.length) {
        const cmd = tokens[i++]!;
        if (cmd === 'M') {
            pen = [num(), num()];
            current = null;
        } else if (cmd === 'Z') {
            const sp = open();
            sp.segments.push(makeSegment([pen, sp.start], tolerance));
            sp.closed = true;
            pen = sp.start;
            current = null; // a drawing command after Z starts a new subpath at the same point
        } else {
            const count = cmd === 'L' ? 1 : cmd === 'Q' ? 2 : 3;
            const pts: Point[] = [pen];
            for (let k = 0; k < count; k++) pts.push([num(), num()]);
            open().segments.push(makeSegment(pts, tolerance));
            pen = pts[pts.length - 1]!;
        }
    }
    for (const sp of subpaths) sp.length = sp.segments.reduce((sum, s) => sum + s.length, 0);
    return subpaths;
}

/**
 * Dash intervals [start, end] along a subpath of length `length`, or null past `budget` dashes.
 * Adjacent dashes (zero-length gap) are merged.
 */
function dashIntervals(length: number, pattern: number[], offset: number, budget: number): [number, number][] | null {
    const period = pattern.reduce((a, b) => a + b, 0);
    let pos = ((offset % period) + period) % period;
    let i = 0;
    while (pos > 0 && pos >= pattern[i]!) {
        pos -= pattern[i]!;
        i = (i + 1) % pattern.length;
    }
    const out: [number, number][] = [];
    // Each step crosses one pattern entry; bounded so zero-length entries cannot spin forever.
    let steps = (budget + 1) * pattern.length;
    let s = 0;
    let remaining = pattern[i]! - pos;
    for (;;) {
        const end = s + remaining;
        if (i % 2 === 0) {
            const last = out[out.length - 1];
            if (last && last[1] === s) last[1] = Math.min(end, length);
            else {
                if (out.length >= budget) return null;
                out.push([s, Math.min(end, length)]);
            }
        }
        if (end >= length) return out;
        if (--steps < 0) return null;
        s = end;
        i = (i + 1) % pattern.length;
        remaining = pattern[i]!;
    }
}

/** Serializes dash pieces of one subpath into pathData commands. */
class Writer {
    private readonly parts: string[] = [];

    constructor(private readonly precision: number) {}

    private pt(p: Point): string {
        return `${formatNumber(p[0], this.precision)} ${formatNumber(p[1], this.precision)}`;
    }

    /** Appends the geometry of `sp` between arc lengths a ≤ b; `move` starts a new sub-path. */
    span(sp: Subpath, a: number, b: number, move: boolean): void {
        let s0 = 0;
        for (const seg of sp.segments) {
            const s1 = s0 + seg.length;
            if (a === b && s0 <= a && a <= s1) {
                // Zero-length dash: a zero-length segment, capped as a dot by round/square caps.
                const p = pointAt(seg, a - s0);
                this.parts.push(`${move ? `M${this.pt(p)}` : ''}L${this.pt(p)}`);
                return;
            }
            if (a < b && s1 > a && s0 < b) {
                const ta = paramAt(seg, a - s0);
                const tb = paramAt(seg, b - s0);
                const piece = seg.pts.length === 2 ? lerpLine(seg.pts, ta, tb) : subCurve(seg.pts, ta, tb);
                if (move) this.parts.push(`M${this.pt(piece[0]!)}`);
                move = false;
                const cmd = piece.length === 2 ? 'L' : piece.length === 3 ? 'Q' : 'C';
                this.parts.push(cmd + piece.slice(1).map((p) => this.pt(p)).join(' '));
                if (s1 >= b) return;
            }
            s0 = s1;
        }
    }

    close(): void {
        this.parts.push('Z');
    }

    toString(): string {
        return this.parts.join('');
    }
}

/** Point at arc length `s` from the start of a segment. */
function pointAt(seg: Segment, s: number): Point {
    const t = paramAt(seg, s);
    return seg.pts.length === 2 ? lerpLine(seg.pts, t, t)[0]! : subCurve(seg.pts, 0, t).at(-1)!;
}

const lerpLine = ([p, q]: Point[], ta: number, tb: number): Point[] => [
    [p![0] + (q![0] - p![0]) * ta, p![1] + (q![1] - p![1]) * ta],
    [p![0] + (q![0] - p![0]) * tb, p![1] + (q![1] - p![1]) * tb],
];

export interface DashOptions {
    /** Decimal places of the emitted coordinates. @default 3 */
    precision?: number;
    /** The element's `pathLength`: dash lengths and offset are scaled by (actual length / pathLength). */
    pathLength?: number;
}

/**
 * Returns the pathData of the dashes of `d` (one open sub-path per dash, absolute M/L/Q/C/Z), or
 * null when the pattern would produce more than {@link MAX_DASHES} dashes. `dasharray` must be a
 * valid pattern as returned by {@link parseDasharray} (even length, non-negative, positive sum).
 * `tolerance` (user units) bounds the arc-length error of each curve flattening piece.
 */
export function dashPathData(
    d: string,
    dasharray: number[],
    dashoffset: number,
    tolerance: number,
    options: DashOptions = {},
): string | null {
    const { precision = 3, pathLength } = options;
    const subpaths = parseSubpaths(d, tolerance > 0 ? tolerance : 1e-3);
    let pattern = dasharray;
    let offset = dashoffset;
    if (pathLength !== undefined && pathLength > 0) {
        const scale = subpaths.reduce((sum, sp) => sum + sp.length, 0) / pathLength;
        pattern = pattern.map((v) => v * scale);
        offset *= scale;
    }
    if (!(pattern.reduce((a, b) => a + b, 0) > 0)) return null;
    // No gap: one dash per subpath, i.e. the solid stroke.
    if (pattern.every((v, i) => i % 2 === 0 || v === 0)) return transformPathData(d, IDENTITY);

    const out = new Writer(precision);
    let budget = MAX_DASHES;
    for (const sp of subpaths) {
        if (!sp.segments.length) continue;
        const intervals = dashIntervals(sp.length, pattern, offset, budget);
        if (!intervals) return null;
        budget -= intervals.length;
        const L = sp.length;
        const full = intervals.length === 1 && intervals[0]![0] <= 0 && intervals[0]![1] >= L;
        if (full && sp.closed && L > 0) {
            // One dash covers the whole closed subpath: it is the original, closing corner joined.
            out.span(sp, 0, L, true);
            out.close();
            continue;
        }
        // On a closed subpath, a dash ending at the end continues into one starting at 0.
        const wrap =
            sp.closed && L > 0 && intervals.length > 1 && intervals[0]![0] <= 0 && intervals.at(-1)![1] >= L;
        const body = wrap ? intervals.slice(1, -1) : intervals;
        for (const [a, b] of body) out.span(sp, a, b, true);
        if (wrap) {
            out.span(sp, intervals.at(-1)![0], L, true);
            out.span(sp, 0, intervals[0]![1], false);
        }
    }
    return out.toString();
}

/**
 * Resolves a `stroke-dasharray` value into an even-length list of user-unit lengths (an odd list
 * is repeated, per SVG). `%` is relative to `diagonal` (the normalized viewport diagonal).
 * Returns `[]` when the stroke is solid (`none`, all zeros, no gap, or a negative value — invalid
 * per SVG, hence no dashing) and null when a value cannot be resolved here (e.g. `em`), so the caller warns.
 */
export function parseDasharray(raw: string | undefined, diagonal: number): number[] | null {
    const value = raw?.trim() ?? 'none';
    if (value === '' || value.toLowerCase() === 'none') return [];
    const list = value.split(/[\s,]+/).filter(Boolean);
    const lengths = list.map((v) => parseLength(v, diagonal));
    if (lengths.some((v) => Number.isNaN(v))) return null;
    if (lengths.some((v) => v < 0) || lengths.every((v) => v === 0)) return [];
    const pattern = lengths.length % 2 ? [...lengths, ...lengths] : lengths;
    // Without any gap, the dashes join into the solid stroke.
    return pattern.some((v, i) => i % 2 === 1 && v > 0) ? pattern : [];
}

/** Shape path of a circle / ellipse as written by shapes.ts: `M cx-rx,cy a… 0 1 0 2rx,0 a…z`. */
const SHAPE_ELLIPSE_RE = /^M(-?[\d.e+-]+),(-?[\d.e+-]+)a([\d.e+-]+),([\d.e+-]+) 0 1 0 /;

/**
 * Re-expresses a circle / ellipse path from shapes.ts in the direction SVG 2 specifies for dashing
 * (start at (cx+rx, cy), positive angle direction, i.e. clockwise on screen). shapes.ts starts at
 * (cx−rx, cy) and turns the other way, which draws the same fill and solid stroke but would shift
 * every dash. Returns `d` unchanged when it is not such a path.
 */
export function ellipseDashPath(d: string): string {
    const m = SHAPE_ELLIPSE_RE.exec(d);
    if (!m) return d;
    const rx = Number(m[3]);
    const ry = Number(m[4]);
    const cx = Number(m[1]) + rx;
    const cy = Number(m[2]);
    if (![rx, ry, cx, cy].every(Number.isFinite)) return d;
    const a = `A${rx},${ry} 0 0 1 `;
    return (
        `M${cx + rx},${cy}${a}${cx},${cy + ry}${a}${cx - rx},${cy}` + `${a}${cx},${cy - ry}${a}${cx + rx},${cy}Z`
    );
}
