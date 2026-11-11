import { formatNumber } from './format.js';
import { fmt, toAbsolute } from './pathAbsolute.js';
import { transformPathData } from './pathData.js';
import { parsePath } from './pathParse.js';
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
 * Lines are cut exactly. Quadratic and cubic Béziers are cut at arc-length parameters and emitted
 * as exact De Casteljau sub-curves, so the output stays compact and smooth: only the *position* of a
 * cut is approximated. Arc length is measured by adaptive subdivision until, for each piece, control
 * polygon length − chord length ≤ `tolerance`, and the piece length is Gravesen's estimate
 * `(2·chord + (n−1)·polygon) / (n+1)`, whose error is a small fraction of that bound.
 *
 * Elliptical arcs (`A`, hence `<circle>` / `<ellipse>`) are measured on the true conic, not on their
 * cubic approximation, which is longer than the curve (+0.014 % for a circle: 0.09 on r = 100, enough
 * to shift every cut and to start a parasitic dash before the end of a full circle). A circular arc
 * has the exact length r·|Δθ| and is cut at exact angles; an elliptical one is cut at angles found by
 * Gauss–Legendre integration of its speed. Each dash piece is then emitted as cubics of ≤ 90°, the
 * same lowering as a plain arc.
 */

/** Above this many dashes for one path, dashing gives up (null) rather than emit huge pathData. */
export const MAX_DASHES = 10_000;

/** Max subdivision depth of a curve when measuring its arc length (2^16 pieces). */
const MAX_DEPTH = 16;

type Point = [number, number];

/** Center parameterization of an elliptical arc (SVG 2 implementation notes, B.2.4). */
interface Arc {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    cosPhi: number;
    sinPhi: number;
    /** Start angle and signed sweep (radians); the segment parameter t maps to theta + t·delta. */
    theta: number;
    delta: number;
}

interface Segment {
    /** Start point then control points then end point (2 for a line, 3 for a quad, 4 for a cubic). */
    pts: Point[];
    length: number;
    /** Curves only: parameters and cumulative lengths of the flattening pieces (both start at 0). */
    ts?: number[];
    ss?: number[];
    /** Elliptical arcs only (then `pts` holds the two end points). */
    arc?: Arc;
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
    return { pts, ...lengthTable(pairs) };
}

/** Cumulates flattening pieces given as (t, length) pairs into a segment's length and ts / ss tables. */
function lengthTable(pairs: number[]): { length: number; ts: number[]; ss: number[] } {
    const ts = [0];
    const ss = [0];
    for (let i = 0; i < pairs.length; i += 2) {
        ts.push(pairs[i]!);
        ss.push(ss[ss.length - 1]! + pairs[i + 1]!);
    }
    return { length: ss[ss.length - 1]!, ts, ss };
}

/** Nodes and weights of 5-point Gauss–Legendre quadrature on [−1, 1]. */
const GL_NODES = [0, 0.5384693101056831, -0.5384693101056831, 0.906179845938664, -0.906179845938664];
const GL_WEIGHTS = [
    0.5688888888888889, 0.47862867049936647, 0.47862867049936647, 0.23692688505618908, 0.23692688505618908,
];

/** Length of an ellipse arc between angles a and b (rotation does not change lengths). */
function ellipseLength(rx: number, ry: number, a: number, b: number): number {
    const half = (b - a) / 2;
    const mid = (a + b) / 2;
    let sum = 0;
    for (let k = 0; k < GL_NODES.length; k++) {
        const t = mid + half * GL_NODES[k]!;
        sum += GL_WEIGHTS[k]! * Math.hypot(rx * Math.sin(t), ry * Math.cos(t));
    }
    return Math.abs(half) * sum;
}

/**
 * Appends (t, length) pieces of an ellipse arc on parameters [t0, t1] (angle = theta + t·delta),
 * subdividing until arc length is linear in t within `tolerance / 2` at the quarter points of each
 * piece (so within about `tolerance` in between), which is what {@link paramAt} assumes.
 */
function measureArc(arc: Arc, t0: number, t1: number, tolerance: number, depth: number, out: number[]): void {
    const angle = (t: number): number => arc.theta + t * arc.delta;
    const q: number[] = [];
    for (let k = 0; k < 4; k++)
        q.push(ellipseLength(arc.rx, arc.ry, angle(t0 + ((t1 - t0) * k) / 4), angle(t0 + ((t1 - t0) * (k + 1)) / 4)));
    const length = q[0]! + q[1]! + q[2]! + q[3]!;
    let deviation = 0;
    for (let k = 1, acc = 0; k < 4; k++)
        deviation = Math.max(deviation, Math.abs((acc += q[k - 1]!) - (length * k) / 4));
    if (deviation <= tolerance / 2 || depth >= MAX_DEPTH) {
        out.push(t1, length);
        return;
    }
    const mid = (t0 + t1) / 2;
    measureArc(arc, t0, mid, tolerance, depth + 1, out);
    measureArc(arc, mid, t1, tolerance, depth + 1, out);
}

/**
 * Segment of an SVG arc from p0 to p1 (`A rx ry phi large sweep`): a line when a radius is zero or the
 * end points coincide (SVG 2 out-of-range parameters), else the arc in center parameterization. Same
 * conversion as pathAbsolute.ts `arcToCubics`, but not the same arithmetic (atan2 angles here, acos
 * there): merging them moves dash cuts by up to 0.005 on arcs whose radii were scaled up, so they stay
 * apart until that output change is accepted.
 */
function makeArcSegment(p0: Point, p1: Point, args: number[], tolerance: number): Segment {
    let rx = Math.abs(args[0]!);
    let ry = Math.abs(args[1]!);
    if (rx === 0 || ry === 0 || (p0[0] === p1[0] && p0[1] === p1[1])) return makeSegment([p0, p1], tolerance);
    const phi = (args[2]! * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const dx = (p0[0] - p1[0]) / 2;
    const dy = (p0[1] - p1[1]) / 2;
    const x1 = cosPhi * dx + sinPhi * dy;
    const y1 = -sinPhi * dx + cosPhi * dy;
    // Radii too small to span the chord are scaled up uniformly.
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
        rx *= Math.sqrt(lambda);
        ry *= Math.sqrt(lambda);
    }
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let coef = Math.sqrt(Math.max(0, rx * rx * ry * ry - den) / den);
    if ((args[3] !== 0) === (args[4] !== 0)) coef = -coef;
    const cxp = (coef * rx * y1) / ry;
    const cyp = (-coef * ry * x1) / rx;
    const cx = cosPhi * cxp - sinPhi * cyp + (p0[0] + p1[0]) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (p0[1] + p1[1]) / 2;
    const theta = Math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx);
    let delta = Math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx) - theta;
    if (args[4] === 0 && delta > 0) delta -= 2 * Math.PI;
    else if (args[4] !== 0 && delta < 0) delta += 2 * Math.PI;
    const arc: Arc = { cx, cy, rx, ry, cosPhi, sinPhi, theta, delta };
    // Circular arc: exact length, and arc length is linear in the angle.
    if (rx === ry) return { pts: [p0, p1], length: rx * Math.abs(delta), arc };
    const pairs: number[] = [];
    // Start from ≤ 90° pieces: a piece symmetric about an axis would hide its non-linearity.
    const quarters = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
    for (let k = 0; k < quarters; k++) measureArc(arc, k / quarters, (k + 1) / quarters, tolerance, 0, pairs);
    return { pts: [p0, p1], ...lengthTable(pairs), arc };
}

/** Point and derivative (w.r.t. the angle) of an arc's ellipse at angle `a`. */
function ellipseAt(arc: Arc, a: number): [Point, Point] {
    const { cx, cy, rx, ry, cosPhi, sinPhi } = arc;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        [cx + cosPhi * rx * c - sinPhi * ry * s, cy + sinPhi * rx * c + cosPhi * ry * s],
        [-cosPhi * rx * s - sinPhi * ry * c, -sinPhi * rx * s + cosPhi * ry * c],
    ];
}

/** Cubics (≤ 90° each, standard 4/3·tan(Δ/4) handles) of an arc between parameters ta and tb. */
function arcCubics(arc: Arc, ta: number, tb: number): Point[][] {
    const a0 = arc.theta + ta * arc.delta;
    const sweep = (tb - ta) * arc.delta;
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const k = (4 / 3) * Math.tan(step / 4);
    const out: Point[][] = [];
    let [p, dp] = ellipseAt(arc, a0);
    for (let i = 1; i <= n; i++) {
        const [q, dq] = ellipseAt(arc, a0 + i * step);
        out.push([p, [p[0] + k * dp[0], p[1] + k * dp[1]], [q[0] - k * dq[0], q[1] - k * dq[1]], q]);
        p = q;
        dp = dq;
    }
    return out;
}

/** The geometry of a segment between parameters ta ≤ tb, as Bézier point lists (lines: 2 points). */
function pieces(seg: Segment, ta: number, tb: number): Point[][] {
    if (seg.arc) return arcCubics(seg.arc, ta, tb);
    return [seg.pts.length === 2 ? lerpLine(seg.pts, ta, tb) : subCurve(seg.pts, ta, tb)];
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

/** Splits a path into subpaths of line / quad / cubic / arc segments, in absolute coordinates. */
function parseSubpaths(d: string, tolerance: number): Subpath[] {
    const commands = parsePath(d);
    // Arcs are measured on the true ellipse: hand toAbsolute a line to the arc's end point instead, so
    // it maps commands one to one (it would lower an arc to cubics) and still resolves relative and
    // shorthand coordinates. Coordinates are rounded like transformPathData output.
    const arcArgs = commands.map((c) => (c.cmd === 'A' || c.cmd === 'a' ? c.args : null));
    const abs = toAbsolute(
        commands.map((c, k) => (arcArgs[k] ? { cmd: c.cmd === 'A' ? 'L' : 'l', args: c.args.slice(5) } : c)),
    );
    const subpaths: Subpath[] = [];
    let current: Subpath | null = null;
    let pen: Point = [0, 0];
    const open = (): Subpath => {
        if (!current) {
            current = { start: pen, segments: [], closed: false, length: 0 };
            subpaths.push(current);
        }
        return current;
    };
    abs.forEach(({ cmd, args }, k) => {
        const pts: Point[] = [pen];
        for (let j = 0; j + 1 < args.length; j += 2) pts.push([Number(fmt(args[j]!)), Number(fmt(args[j + 1]!))]);
        if (cmd === 'M') {
            pen = pts[1]!;
            current = null;
        } else if (cmd === 'Z') {
            const sp = open();
            sp.segments.push(makeSegment([pen, sp.start], tolerance));
            sp.closed = true;
            pen = sp.start;
            current = null; // a drawing command after Z starts a new subpath at the same point
        } else {
            const arc = arcArgs[k];
            open().segments.push(arc ? makeArcSegment(pen, pts[1]!, arc, tolerance) : makeSegment(pts, tolerance));
            pen = pts[pts.length - 1]!;
        }
    });
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
                for (const piece of pieces(seg, paramAt(seg, a - s0), paramAt(seg, b - s0))) {
                    if (move) this.parts.push(`M${this.pt(piece[0]!)}`);
                    move = false;
                    const cmd = piece.length === 2 ? 'L' : piece.length === 3 ? 'Q' : 'C';
                    this.parts.push(
                        cmd +
                            piece
                                .slice(1)
                                .map((p) => this.pt(p))
                                .join(' '),
                    );
                }
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
    if (seg.arc) return ellipseAt(seg.arc, seg.arc.theta + t * seg.arc.delta)[0];
    return seg.pts.length === 2 ? lerpLine(seg.pts, t, t)[0]! : subCurve(seg.pts, 0, t).at(-1)!;
}

const lerpLine = ([p, q]: Point[], ta: number, tb: number): Point[] => [
    [p![0] + (q![0] - p![0]) * ta, p![1] + (q![1] - p![1]) * ta],
    [p![0] + (q![0] - p![0]) * tb, p![1] + (q![1] - p![1]) * tb],
];

export interface DashOptions {
    /** Decimal places of the emitted coordinates. @default 3 */
    precision?: number;
    /**
     * The element's `pathLength`: dash lengths and offset are scaled by (actual length / pathLength).
     * Zero means a scaling factor of infinity (SVG 2, the `pathLength` attribute): the stroke is drawn
     * solid, as Chrome and Firefox do. A negative value is an error and is ignored, like an absent one.
     */
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
    // pathLength="0": every non-zero dash and gap becomes infinite, which browsers draw solid.
    if (pathLength === 0) return transformPathData(d, IDENTITY);
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
        const wrap = sp.closed && L > 0 && intervals.length > 1 && intervals[0]![0] <= 0 && intervals.at(-1)![1] >= L;
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
 * per SVG, hence no dashing) and null when a value cannot be resolved here (e.g. `ex`), so the caller warns.
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
    return `M${cx + rx},${cy}${a}${cx},${cy + ry}${a}${cx - rx},${cy}` + `${a}${cx},${cy - ry}${a}${cx + rx},${cy}Z`;
}
