import { fmt, toAbsolute } from './pathAbsolute.js';
import { cubicAt, quadAt } from './pathBBox.js';
import { parsePath } from './pathParse.js';

/*
 * Fill-rule rewriting: evenodd → nonzero by contour orientation.
 *
 * For closed contours that neither intersect nor touch each other or themselves, every pair is either
 * nested or disjoint. The evenodd region is then "inside an odd number of contours", which is exactly
 * the nonzero region once a contour at nesting depth k is oriented `s·(-1)^k`: the winding number just
 * inside it is s (k even) or 0 (k odd). Open subpaths are closed by a straight line, as SVG fills them.
 *
 * Orientation uses the exact signed area of the curves (Green's theorem, closed forms for lines,
 * quadratic and cubic Béziers). The intersection and containment tests run on a flattened copy, at a
 * tolerance of {@link FLATTEN_TOLERANCE} × the path's bounding-box diagonal: a crossing narrower than
 * that (≈ 0.01 % of the path) can go unnoticed, its rendering error being of the same size.
 */

/** Flattening tolerance, relative to the path's bounding-box diagonal. */
const FLATTEN_TOLERANCE = 1e-4;
/** Cap on flattened segments: beyond it the analysis gives up (returns null). */
const MAX_SEGMENTS = 20_000;
/** Cap on elementary tests (segment pairs, point-in-polygon edges): bounds the worst case, O(n²) sweeps. */
const MAX_WORK = 4_000_000;

/** One absolute segment of a contour: its control points then its end point, flat [x, y, …]. */
interface Segment {
    cmd: 'L' | 'Q' | 'C';
    pts: number[];
}

/** A closed contour: start point plus segments, the last one ending back on the start. */
interface Contour {
    x: number;
    y: number;
    segs: Segment[];
}

/** Splits a path into closed contours (open subpaths closed by a line, empty ones dropped). */
function contoursOf(d: string): Contour[] {
    const contours: Contour[] = [];
    let cur: Contour | null = null;
    let px = 0;
    let py = 0;
    const finish = (): void => {
        if (cur && cur.segs.length) {
            if (px !== cur.x || py !== cur.y) cur.segs.push({ cmd: 'L', pts: [cur.x, cur.y] });
            contours.push(cur);
        }
        cur = null;
    };
    for (const { cmd, args } of toAbsolute(parsePath(d))) {
        if (cmd === 'M') {
            finish();
            px = args[0]!;
            py = args[1]!;
            cur = { x: px, y: py, segs: [] };
        } else if (cmd === 'Z') {
            const start: Contour | null = cur;
            finish();
            // The pen returns to the subpath start, where a command without M begins the next one.
            if (start) {
                px = start.x;
                py = start.y;
            }
        } else {
            cur ??= { x: px, y: py, segs: [] };
            cur.segs.push({ cmd, pts: args });
            px = args[args.length - 2]!;
            py = args[args.length - 1]!;
        }
    }
    finish();
    return contours;
}

/** Twice the signed area of a closed contour (positive = clockwise on screen, y pointing down). */
function doubleArea(c: Contour): number {
    let sum = 0;
    let x0 = c.x;
    let y0 = c.y;
    for (const { cmd, pts: p } of c.segs) {
        let x1: number, y1: number, x2: number, y2: number;
        const x3 = p[p.length - 2]!;
        const y3 = p[p.length - 1]!;
        if (cmd === 'L') {
            sum += x0 * y3 - x3 * y0;
        } else {
            if (cmd === 'Q') {
                // Degree elevation: the same curve as an exact cubic.
                x1 = x0 + (2 / 3) * (p[0]! - x0);
                y1 = y0 + (2 / 3) * (p[1]! - y0);
                x2 = x3 + (2 / 3) * (p[0]! - x3);
                y2 = y3 + (2 / 3) * (p[1]! - y3);
            } else {
                [x1, y1, x2, y2] = p as [number, number, number, number];
            }
            // ∫ (x·y' − y·x') dt over the cubic, expanded on its control points.
            const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - bx * ay;
            sum +=
                (6 * cross(x0, y0, x1, y1) +
                    3 * cross(x0, y0, x2, y2) +
                    cross(x0, y0, x3, y3) +
                    3 * cross(x1, y1, x2, y2) +
                    3 * cross(x1, y1, x3, y3) +
                    6 * cross(x2, y2, x3, y3)) /
                10;
        }
        x0 = x3;
        y0 = y3;
    }
    return sum;
}

/** The same contour traversed backwards (every segment reversed exactly). */
function reverseContour(c: Contour): Contour {
    const out: Segment[] = [];
    for (let i = c.segs.length - 1; i >= 0; i -= 1) {
        const { cmd, pts } = c.segs[i]!;
        const prev = i > 0 ? c.segs[i - 1]!.pts : [c.x, c.y];
        const [px, py] = [prev[prev.length - 2]!, prev[prev.length - 1]!];
        if (cmd === 'L') out.push({ cmd, pts: [px, py] });
        else if (cmd === 'Q') out.push({ cmd, pts: [pts[0]!, pts[1]!, px, py] });
        else out.push({ cmd, pts: [pts[2]!, pts[3]!, pts[0]!, pts[1]!, px, py] });
    }
    return { x: c.x, y: c.y, segs: out };
}

const contourPath = (c: Contour): string =>
    `M${fmt(c.x)} ${fmt(c.y)}` + c.segs.map(({ cmd, pts }) => cmd + pts.map(fmt).join(' ')).join('') + 'Z';

/** Flattens a contour into a closed polyline [x0, y0, x1, y1, …] (no repeated consecutive points). */
function flattenContour(c: Contour, tol: number): number[] {
    const out = [c.x, c.y];
    const push = (x: number, y: number): void => {
        if (x !== out[out.length - 2] || y !== out[out.length - 1]) out.push(x, y);
    };
    let x0 = c.x;
    let y0 = c.y;
    for (const { cmd, pts: p } of c.segs) {
        const x3 = p[p.length - 2]!;
        const y3 = p[p.length - 1]!;
        if (cmd !== 'L') {
            // Wang's bound: n uniform steps keep the chord error under `tol`.
            const cubic = cmd === 'C';
            const [ax, ay, bx, by] = cubic ? p : [p[0]!, p[1]!, p[0]!, p[1]!];
            const dd = cubic
                ? Math.max(
                      Math.hypot(x0 - 2 * ax! + bx!, y0 - 2 * ay! + by!),
                      Math.hypot(ax! - 2 * bx! + x3, ay! - 2 * by! + y3),
                  )
                : Math.hypot(x0 - 2 * ax! + x3, y0 - 2 * ay! + y3);
            const n = Math.min(1024, Math.max(1, Math.ceil(Math.sqrt(((cubic ? 0.75 : 0.25) * dd) / tol))));
            for (let k = 1; k < n; k += 1) {
                const t = k / n;
                if (cubic) push(cubicAt(t, x0, ax!, bx!, x3), cubicAt(t, y0, ay!, by!, y3));
                else push(quadAt(t, x0, ax!, x3), quadAt(t, y0, ay!, y3));
            }
        }
        push(x3, y3);
        x0 = x3;
        y0 = y3;
    }
    // The closing point duplicates the start: drop it, the polyline is implicitly closed.
    if (out.length > 2 && out[out.length - 2] === c.x && out[out.length - 1] === c.y) out.length -= 2;
    return out;
}

/** Whether every vertex of a polyline lies on one line (relative tolerance): it encloses no area. */
function isFlat(poly: number[]): boolean {
    const [x0, y0] = [poly[0]!, poly[1]!];
    let fx = 0;
    let fy = 0;
    let len = 0;
    for (let i = 2; i < poly.length; i += 2) {
        const l = Math.hypot(poly[i]! - x0, poly[i + 1]! - y0);
        if (l > len) [fx, fy, len] = [poly[i]! - x0, poly[i + 1]! - y0, l];
    }
    if (len === 0) return true;
    for (let i = 2; i < poly.length; i += 2)
        if (Math.abs(fx * (poly[i + 1]! - y0) - fy * (poly[i]! - x0)) > 1e-9 * len * len) return false;
    return true;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Whether c lies within the bounding box of segment ab (used once c is known to be collinear). */
const within = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean =>
    Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by);

/** Whether segments pq and rs share at least one point (touching counts). */
function segmentsMeet(s: readonly number[]): boolean {
    const [px, py, qx, qy, rx, ry, sx, sy] = s as [number, number, number, number, number, number, number, number];
    const d1 = orient(rx, ry, sx, sy, px, py);
    const d2 = orient(rx, ry, sx, sy, qx, qy);
    const d3 = orient(px, py, qx, qy, rx, ry);
    const d4 = orient(px, py, qx, qy, sx, sy);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    return (
        (d1 === 0 && within(rx, ry, sx, sy, px, py)) ||
        (d2 === 0 && within(rx, ry, sx, sy, qx, qy)) ||
        (d3 === 0 && within(px, py, qx, qy, rx, ry)) ||
        (d4 === 0 && within(px, py, qx, qy, sx, sy))
    );
}

/** Even-odd point-in-polygon (horizontal ray, half-open edges). */
function pointInPolygon(x: number, y: number, poly: number[]): boolean {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const [xi, yi, xj, yj] = [poly[i]!, poly[i + 1]!, poly[j]!, poly[j + 1]!];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** The non-degenerate contours of a path with their orientation, nesting and intersection status. */
interface ContourAnalysis {
    contours: Contour[];
    /** Orientation of each contour: 1 (positive signed area) or -1. */
    orientation: (1 | -1)[];
    /** Index of the innermost contour containing each one, -1 at the top level (meaningful without crossings). */
    parent: number[];
    /** Number of contours containing each one (meaningful without crossings). */
    depth: number[];
    /** A contour crosses or touches itself. */
    selfIntersects: boolean;
    /** Two different contours cross or touch. */
    crossIntersects: boolean;
}

/** Analyzes a path's contours; null when it exceeds the caps ({@link MAX_SEGMENTS}, {@link MAX_WORK}). */
function analyzeContours(d: string): ContourAnalysis | null {
    const all = contoursOf(d);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of all)
        for (const { pts } of c.segs)
            for (let k = 0; k + 1 < pts.length; k += 2) {
                minX = Math.min(minX, pts[k]!);
                maxX = Math.max(maxX, pts[k]!);
                minY = Math.min(minY, pts[k + 1]!);
                maxY = Math.max(maxY, pts[k + 1]!);
            }
    const tol = Math.hypot(maxX - minX, maxY - minY) * FLATTEN_TOLERANCE;
    const contours: Contour[] = [];
    const polys: number[][] = [];
    let total = 0;
    if (tol > 0 && Number.isFinite(tol))
        for (const c of all) {
            const poly = flattenContour(c, tol);
            if (poly.length < 6 || isFlat(poly)) continue; // encloses nothing, paints nothing
            total += poly.length / 2;
            if (total > MAX_SEGMENTS) return null;
            contours.push(c);
            polys.push(poly);
        }

    // Segment table: [x1, y1, x2, y2] per segment, with its contour and index along the contour.
    const seg: number[] = [];
    const owner: number[] = [];
    const index: number[] = [];
    polys.forEach((poly, c) => {
        const n = poly.length;
        for (let i = 0; i < n; i += 2) {
            seg.push(poly[i]!, poly[i + 1]!, poly[(i + 2) % n]!, poly[(i + 3) % n]!);
            owner.push(c);
            index.push(i / 2);
        }
    });
    const minXOf = (s: number): number => Math.min(seg[4 * s]!, seg[4 * s + 2]!);
    const maxXOf = (s: number): number => Math.max(seg[4 * s]!, seg[4 * s + 2]!);
    const order = owner.map((_, s) => s).sort((a, b) => minXOf(a) - minXOf(b));

    let work = 0;
    let selfIntersects = false;
    let crossIntersects = false;
    let active: number[] = [];
    // Sweep along x: only segments whose x-ranges overlap are compared.
    for (const s of order) {
        const x = minXOf(s);
        work += active.length;
        if (work > MAX_WORK) return null;
        active = active.filter((a) => maxXOf(a) >= x);
        const sy1 = Math.min(seg[4 * s + 1]!, seg[4 * s + 3]!);
        const sy2 = Math.max(seg[4 * s + 1]!, seg[4 * s + 3]!);
        for (const a of active) {
            if (Math.max(seg[4 * a + 1]!, seg[4 * a + 3]!) < sy1 || Math.min(seg[4 * a + 1]!, seg[4 * a + 3]!) > sy2)
                continue;
            const pair = [...seg.slice(4 * a, 4 * a + 4), ...seg.slice(4 * s, 4 * s + 4)];
            if (owner[a] !== owner[s]) {
                if (!crossIntersects && segmentsMeet(pair)) crossIntersects = true;
                continue;
            }
            if (selfIntersects) continue;
            const n = polys[owner[s]!]!.length / 2;
            const gap = Math.abs(index[a]! - index[s]!);
            if (gap === 1 || gap === n - 1) {
                // Neighbours share an end point: they only overlap when one doubles back on the other.
                const [ax, ay, bx, by, cx, cy, ex, ey] = pair as [
                    number,
                    number,
                    number,
                    number,
                    number,
                    number,
                    number,
                    number,
                ];
                const [ux, uy, vx, vy] = [bx - ax, by - ay, ex - cx, ey - cy];
                if (
                    Math.abs(ux * vy - uy * vx) <= 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy) &&
                    ux * vx + uy * vy < 0
                )
                    selfIntersects = true;
            } else if (segmentsMeet(pair)) selfIntersects = true;
        }
        if (selfIntersects && crossIntersects) break;
        active.push(s);
    }

    const orientation = contours.map((c) => (doubleArea(c) >= 0 ? 1 : -1) as 1 | -1);
    // Containment (valid when contours do not cross): B holds A when A's box fits in B's and a vertex of A is inside B.
    const boxes = polys.map((poly) => {
        const xs = poly.filter((_, i) => i % 2 === 0);
        const ys = poly.filter((_, i) => i % 2 === 1);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
    });
    const parent = contours.map(() => -1);
    const depth = contours.map(() => 0);
    if (!crossIntersects)
        for (let a = 0; a < contours.length; a += 1) {
            const [ax1, ay1, ax2, ay2] = boxes[a]!;
            for (let b = 0; b < contours.length; b += 1) {
                const [bx1, by1, bx2, by2] = boxes[b]!;
                if (a === b || ax1 < bx1 || ay1 < by1 || ax2 > bx2 || ay2 > by2) continue;
                work += polys[b]!.length / 2;
                if (work > MAX_WORK) return null;
                if (!pointInPolygon(polys[a]![0]!, polys[a]![1]!, polys[b]!)) continue;
                depth[a]! += 1;
                // Nested contours form a chain: the innermost container is the smallest one.
                const p = parent[a]!;
                if (p < 0 || (bx2 - bx1) * (by2 - by1) < (boxes[p]![2] - boxes[p]![0]) * (boxes[p]![3] - boxes[p]![1]))
                    parent[a] = b;
            }
        }
    return { contours, orientation, parent, depth, selfIntersects, crossIntersects };
}

/**
 * Rewrites an evenodd path into a nonzero path filling the same region, by orienting each contour
 * `orientation·(-1)^depth` (see the section comment above). Without `orientation`, the first top-level
 * contour keeps its own. Returns `d` itself when every contour is already well oriented, otherwise
 * absolute M/L/C/Q/Z data (arcs lowered, open subpaths closed, empty contours dropped). Returns null
 * when the contours cross or touch (themselves or each other), or when the path exceeds the caps.
 */
export function evenOddToNonZero(d: string, orientation?: 1 | -1): string | null {
    const a = analyzeContours(d);
    if (!a || a.selfIntersects || a.crossIntersects) return null;
    const outer = orientation ?? a.orientation[a.depth.indexOf(0)] ?? 1;
    const wanted = a.depth.map((k) => (k % 2 === 0 ? outer : -outer));
    if (wanted.every((o, i) => o === a.orientation[i])) return d;
    return a.contours.map((c, i) => contourPath(wanted[i] === a.orientation[i] ? c : reverseContour(c))).join('');
}

/**
 * Sign of the winding number of a nonzero path where it is not 0: 1 when it is ≥ 0 everywhere, -1
 * when ≤ 0 everywhere. Null when it cannot be proven (self-crossing contours, opposite windings,
 * crossing contours of mixed orientations, caps exceeded) or the path encloses nothing. Concatenating
 * paths of the same sign unites their nonzero regions: windings add up and never cancel.
 */
export function windingSign(d: string): 1 | -1 | null {
    const a = analyzeContours(d);
    if (!a || a.selfIntersects || !a.contours.length) return null;
    const first = a.orientation[0]!;
    if (a.orientation.every((o) => o === first)) return first;
    if (a.crossIntersects) return null;
    // Nested, disjoint contours: the winding inside a contour is the sum of its chain's orientations.
    const winding: number[] = [];
    const windingOf = (i: number): number =>
        (winding[i] ??= a.orientation[i]! + (a.parent[i]! < 0 ? 0 : windingOf(a.parent[i]!)));
    const values = a.contours.map((_, i) => windingOf(i));
    if (values.every((w) => w >= 0)) return 1;
    if (values.every((w) => w <= 0)) return -1;
    return null;
}

/** The path traversed backwards (absolute M/L/C/Q/Z, open subpaths closed): same nonzero region, opposite winding. */
export function reversePathData(d: string): string {
    return contoursOf(d)
        .map((c) => contourPath(reverseContour(c)))
        .join('');
}
