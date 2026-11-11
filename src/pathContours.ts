import { formatNumber } from './format.js';
import { arcCenter, fmt, toAbsolute } from './pathAbsolute.js';
import { cubicAt, quadAt } from './pathBBox.js';
import { type Command, parsePath } from './pathParse.js';

/*
 * Fill-rule rewriting: evenodd → nonzero by contour orientation.
 *
 * For closed contours that do not cross each other or themselves, every pair is either nested or
 * disjoint. The evenodd region is then "inside an odd number of contours", which is exactly the
 * nonzero region once a contour at nesting depth k is oriented `s·(-1)^k`: the winding number just
 * inside it is s (k even) or 0 (k odd). Open subpaths are closed by a straight line, as SVG fills them.
 *
 * Touching is not crossing: two contours meeting at a point or along an edge, each staying on one side
 * of the other, are still nested or disjoint (decided by a part of one away from the contact). A contour
 * touching itself (keyhole bridge, two lobes meeting at a vertex) is split there into simple loops, which
 * play the role of contours; it is reversed whole, so its loops must already alternate as needed.
 *
 * Orientation uses the exact signed area of the curves (Green's theorem, closed forms for lines,
 * quadratic and cubic Béziers). The intersection and containment tests run on a flattened copy, at a
 * tolerance of {@link FLATTEN_TOLERANCE} × the path's bounding-box diagonal: a crossing narrower than
 * that (≈ 0.01 % of the path) can go unnoticed, its rendering error being of the same size. Likewise, a
 * contour ending a hair short of its start is closed there (see {@link CLOSE_TOLERANCE}).
 */

/** Flattening tolerance, relative to the path's bounding-box diagonal. */
const FLATTEN_TOLERANCE = 1e-4;
/**
 * Distance, in flattening tolerances, under which a contour's last vertices merge with its start. The
 * merge moves the polyline by at most that much, the order of the flattening error itself; 2 covers the
 * real-icon closing offsets seen (up to ~2e-3 on a 16 / 24 viewBox).
 */
const CLOSE_TOLERANCE = 2;
/** Cap on flattened segments: beyond it the analysis gives up (returns null). */
const MAX_SEGMENTS = 20_000;
/** Cap on elementary tests (segment pairs, point-in-polygon edges): bounds the worst case, O(n²) sweeps. */
const MAX_WORK = 4_000_000;

/** One absolute segment of a contour: its control points then its end point, flat [x, y, …]. */
interface Segment {
    cmd: 'L' | 'Q' | 'C';
    pts: number[];
}

/**
 * An elliptical arc, kept as such for serialization: `pts` are its A arguments (radii, rotation, flags
 * as 0 / 1, end point), `curves` the cubics the analysis works on (toAbsolute's lowering).
 */
interface Arc {
    cmd: 'A';
    pts: number[];
    curves: Segment[];
}

/** A closed contour: start point plus segments, the last one ending back on the start. */
interface Contour {
    x: number;
    y: number;
    segs: (Segment | Arc)[];
}

/** The segments of a contour, arcs lowered to cubics. */
const curvesOf = (c: Contour): Segment[] => c.segs.flatMap((s) => (s.cmd === 'A' ? s.curves : [s]));

/** The A arguments of an arc command drawn from (px, py), end point absolute, radii positive, flags 0 / 1. */
function arcArgs({ cmd, args }: Command, px: number, py: number): number[] {
    const [ox, oy] = cmd === 'a' ? [px, py] : [0, 0];
    const flag = (v: number): number => (v !== 0 ? 1 : 0);
    return [
        Math.abs(args[0]!),
        Math.abs(args[1]!),
        args[2]!,
        flag(args[3]!),
        flag(args[4]!),
        ox + args[5]!,
        oy + args[6]!,
    ];
}

/** Whether the arc of A arguments `a` drawn from (px, py) is a true arc (not a line, nor omitted). */
const isArc = (a: number[], px: number, py: number): boolean =>
    arcCenter(px, py, a[0]!, a[1]!, a[2]!, a[3] === 1, a[4] === 1, a[5]!, a[6]!) !== null;

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
    const commands = parsePath(d);
    const lowered = toAbsolute(commands);
    let next = 0;
    for (const command of commands) {
        if (command.cmd === 'A' || command.cmd === 'a') {
            const a = arcArgs(command, px, py);
            if (isArc(a, px, py)) {
                // Lowered alone, as toAbsolute lowered it in place: the same cubics, as many.
                const curves = toAbsolute([
                    { cmd: 'M', args: [px, py] },
                    { cmd: 'A', args: a },
                ])
                    .slice(1)
                    .map(({ args }): Segment => ({ cmd: 'C', pts: args }));
                next += curves.length;
                cur ??= { x: px, y: py, segs: [] };
                cur.segs.push({ cmd: 'A', pts: a, curves });
                px = a[5]!;
                py = a[6]!;
                continue;
            }
        }
        // Every other command (a degenerate arc included) is lowered to exactly one.
        const { cmd, args } = lowered[next]!;
        next += 1;
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
    for (const { cmd, pts: p } of curvesOf(c)) {
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

/**
 * Segments drawn from (x, y), traversed backwards (every one reversed exactly): they end on (x, y).
 * An arc stays an arc, its end points swapped and its sweep flag inverted.
 */
function reverseSegments(x: number, y: number, segs: (Segment | Arc)[]): (Segment | Arc)[] {
    const out: (Segment | Arc)[] = [];
    for (let i = segs.length - 1; i >= 0; i -= 1) {
        const seg = segs[i]!;
        const { pts } = seg;
        const prev = i > 0 ? segs[i - 1]!.pts : [x, y];
        const [px, py] = [prev[prev.length - 2]!, prev[prev.length - 1]!];
        if (seg.cmd === 'A') {
            const curves = reverseSegments(px, py, seg.curves) as Segment[];
            out.push({ cmd: 'A', pts: [...pts.slice(0, 4), 1 - pts[4]!, px, py], curves });
        } else if (seg.cmd === 'L') out.push({ cmd: 'L', pts: [px, py] });
        else if (seg.cmd === 'Q') out.push({ cmd: 'Q', pts: [pts[0]!, pts[1]!, px, py] });
        else out.push({ cmd: 'C', pts: [pts[2]!, pts[3]!, pts[0]!, pts[1]!, px, py] });
    }
    return out;
}

/** The same contour traversed backwards (see {@link reverseSegments}). */
const reverseContour = (c: Contour): Contour => ({ x: c.x, y: c.y, segs: reverseSegments(c.x, c.y, c.segs) });

/**
 * Serializes a closed contour, compactly but exactly: each segment in the shorter of its absolute and
 * relative forms, axis-aligned lines as H/V, arcs as A, no closing line before Z (Z draws it). Like svgo:
 * no leading zero (`.5`), no letter a command repeats implicitly (L after M included), no separator
 * before a minus sign nor before a dot that cannot belong to the previous number. Arc flags stay
 * separated by spaces on both sides (see `normalizeArcFlags`). The pen is tracked on rounded positions,
 * so relative offsets land on the very points the absolute form would write.
 */
function contourPath(c: Contour, num: (n: number) => string = fmt): string {
    const round = (n: number): number => Number(num(n));
    const text = (n: number): string => num(n).replace(/^(-?)0\./, '$1.');
    let out = '';
    // Last token written (a letter or a number), and the letter a bare group of numbers repeats.
    let last = '';
    let implicit = '';
    /** A command as written after `out`: its letter unless implied, then its numbers; and its last token. */
    const spell = (letter: string, values: number[]): [string, string] => {
        let s = letter === implicit ? '' : letter;
        let prev = s || last;
        const arc = letter === 'A' || letter === 'a';
        values.map(text).forEach((t, i) => {
            // A dot starts a new number after a number that already has one (and no exponent).
            const glued =
                /^[A-Za-z]$/.test(prev) ||
                (!(arc && i === 5) && (t[0] === '-' || (t[0] === '.' && /^[^e]*\.[^e]*$/.test(prev))));
            s += (glued ? '' : ' ') + t;
            prev = t;
        });
        return [s, prev];
    };
    const write = (letter: string, [s, token]: [string, string]): void => {
        out += s;
        last = token;
        implicit = letter === 'M' ? 'L' : letter === 'm' ? 'l' : letter;
    };
    let x = round(c.x);
    let y = round(c.y);
    write('M', spell('M', [x, y]));
    // The last segment ends on the start point (see contoursOf): a line there is what Z draws.
    const segs = c.segs.length > 1 && c.segs.at(-1)!.cmd === 'L' ? c.segs.slice(0, -1) : c.segs;
    for (const { cmd, pts } of segs) {
        const p = pts.map(round);
        const ex = p[p.length - 2]!;
        const ey = p[p.length - 1]!;
        let abs: [string, number[]];
        let rel: [string, number[]];
        if (cmd === 'L' && ey === y)
            [abs, rel] = [
                ['H', [ex]],
                ['h', [ex - x]],
            ];
        else if (cmd === 'L' && ex === x)
            [abs, rel] = [
                ['V', [ey]],
                ['v', [ey - y]],
            ];
        else if (cmd === 'A')
            [abs, rel] = [
                ['A', p],
                ['a', [...p.slice(0, 5), ex - x, ey - y]],
            ];
        else
            [abs, rel] = [
                [cmd, p],
                [cmd.toLowerCase(), p.map((v, i) => v - (i % 2 === 0 ? x : y))],
            ];
        const [a, r] = [spell(...abs), spell(...rel)];
        if (r[0].length < a[0].length) write(rel[0], r);
        else write(abs[0], a);
        x = ex;
        y = ey;
    }
    return out + 'Z';
}

/** Flattens a contour into a closed polyline [x0, y0, x1, y1, …] (no repeated consecutive points). */
function flattenContour(c: Contour, tol: number): number[] {
    const out = [c.x, c.y];
    const push = (x: number, y: number): void => {
        if (x !== out[out.length - 2] || y !== out[out.length - 1]) out.push(x, y);
    };
    let x0 = c.x;
    let y0 = c.y;
    for (const { cmd, pts: p } of curvesOf(c)) {
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
    // So do the last vertices lying within CLOSE_TOLERANCE·tol of the start (float error, or a source
    // ending 1e-3 off its start before Z): kept, their micro-edge reads as the contour crossing itself, for
    // a sliver of ~tol². A triangle is always kept: a contour that small is still painted (and written back).
    const close = CLOSE_TOLERANCE * tol;
    while (out.length > 6 && Math.hypot(out[out.length - 2]! - c.x, out[out.length - 1]! - c.y) <= close)
        out.length -= 2;
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

/**
 * How segments pq and rs meet: 0 not at all, 1 by touching (an end point of one lies on the other,
 * collinear overlap included), 2 by crossing (each one's interior passes through the other's).
 */
function segmentContact(s: readonly number[]): 0 | 1 | 2 {
    const [px, py, qx, qy, rx, ry, sx, sy] = s as [number, number, number, number, number, number, number, number];
    const d1 = orient(rx, ry, sx, sy, px, py);
    const d2 = orient(rx, ry, sx, sy, qx, qy);
    const d3 = orient(px, py, qx, qy, rx, ry);
    const d4 = orient(px, py, qx, qy, sx, sy);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 2;
    return (d1 === 0 && within(rx, ry, sx, sy, px, py)) ||
        (d2 === 0 && within(rx, ry, sx, sy, qx, qy)) ||
        (d3 === 0 && within(px, py, qx, qy, rx, ry)) ||
        (d4 === 0 && within(px, py, qx, qy, sx, sy))
        ? 1
        : 0;
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

const keyOf = (x: number, y: number): string => `${x},${y}`;

/**
 * Splits a closed polyline at its repeated vertices into closed loops: each time the walk comes back
 * to a vertex already on the stack, the vertices since then form a loop. With every contact of the
 * polyline with itself turned into a shared vertex beforehand, each loop is a simple polygon.
 */
function splitLoops(v: number[]): number[][] {
    const loops: number[][] = [];
    const stack: number[] = [];
    const at = new Map<string, number>();
    for (let i = 0; i < v.length; i += 2) {
        const [x, y] = [v[i]!, v[i + 1]!];
        const j = at.get(keyOf(x, y));
        if (j === undefined) {
            at.set(keyOf(x, y), stack.length / 2);
            stack.push(x, y);
            continue;
        }
        const rest = stack.splice(2 * (j + 1));
        for (let k = 0; k < rest.length; k += 2) at.delete(keyOf(rest[k]!, rest[k + 1]!));
        loops.push([x, y, ...rest]);
    }
    loops.push(stack);
    return loops;
}

/** Twice the signed area of a closed polyline (same sign convention as {@link doubleArea}). */
function polygonDoubleArea(poly: number[]): number {
    let sum = 0;
    const n = poly.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) sum += poly[j]! * poly[i + 1]! - poly[i]! * poly[j + 1]!;
    return sum;
}

/**
 * The non-degenerate contours of a path, split into simple loops, with the orientation and nesting of
 * each loop and the intersection status. A contour touching itself (a vertex on another of its edges,
 * an edge traversed twice, a keyhole bridge) is split there into loops; loops enclosing nothing are dropped.
 */
interface ContourAnalysis {
    contours: Contour[];
    /** Index (in `contours`) of the contour each loop belongs to. */
    contourOf: number[];
    /** Orientation of each loop: 1 (positive signed area) or -1. */
    orientation: (1 | -1)[];
    /** Index of the innermost loop containing each one, -1 at the top level (meaningful without crossings). */
    parent: number[];
    /** Number of loops containing each one (meaningful without crossings). */
    depth: number[];
    /** A contour crosses itself (its loops then mean nothing). */
    selfIntersects: boolean;
    /** Two different contours cross (touching does not count). */
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
        for (const { pts } of curvesOf(c))
            for (let k = 0; k + 1 < pts.length; k += 2) {
                minX = Math.min(minX, pts[k]!);
                maxX = Math.max(maxX, pts[k]!);
                minY = Math.min(minY, pts[k + 1]!);
                maxY = Math.max(maxY, pts[k + 1]!);
            }
    const tol = Math.hypot(maxX - minX, maxY - minY) * FLATTEN_TOLERANCE;
    const flat: Contour[] = [];
    const polys: number[][] = [];
    let total = 0;
    if (tol > 0 && Number.isFinite(tol))
        for (const c of all) {
            const poly = flattenContour(c, tol);
            if (poly.length < 6 || isFlat(poly)) continue; // encloses nothing, paints nothing
            total += poly.length / 2;
            if (total > MAX_SEGMENTS) return null;
            flat.push(c);
            polys.push(poly);
        }

    // Segment table: [x1, y1, x2, y2] per segment, with its contour; a contour's segments are consecutive.
    const seg: number[] = [];
    const owner: number[] = [];
    polys.forEach((poly, c) => {
        const n = poly.length;
        for (let i = 0; i < n; i += 2) {
            seg.push(poly[i]!, poly[i + 1]!, poly[(i + 2) % n]!, poly[(i + 3) % n]!);
            owner.push(c);
        }
    });
    const minXOf = (s: number): number => Math.min(seg[4 * s]!, seg[4 * s + 2]!);
    const maxXOf = (s: number): number => Math.max(seg[4 * s]!, seg[4 * s + 2]!);
    const order = owner.map((_, s) => s).sort((a, b) => minXOf(a) - minXOf(b));

    // Contact points to insert inside each segment, so that every contact becomes a shared vertex.
    const inserts: number[][] = [];
    const insertOn = (t: number, x: number, y: number): void => {
        const [x1, y1, x2, y2] = seg.slice(4 * t, 4 * t + 4) as [number, number, number, number];
        if ((x === x1 && y === y1) || (x === x2 && y === y2)) return;
        if (orient(x1, y1, x2, y2, x, y) === 0 && within(x1, y1, x2, y2, x, y)) (inserts[t] ??= []).push(x, y);
    };
    const notAnalyzed = { contours: [], contourOf: [], orientation: [], parent: [], depth: [] };

    let work = 0;
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
            const self = owner[a] === owner[s];
            // Once two contours cross, only the contacts of a contour with itself still matter (its loops).
            if (!self && crossIntersects) continue;
            const contact = segmentContact([...seg.slice(4 * a, 4 * a + 4), ...seg.slice(4 * s, 4 * s + 4)]);
            if (contact === 2) {
                if (self) return { ...notAnalyzed, selfIntersects: true, crossIntersects };
                crossIntersects = true;
            } else if (contact === 1) {
                // Neighbours meet at their shared end point (skipped): only a doubling back inserts a point.
                insertOn(a, seg[4 * s]!, seg[4 * s + 1]!);
                insertOn(a, seg[4 * s + 2]!, seg[4 * s + 3]!);
                insertOn(s, seg[4 * a]!, seg[4 * a + 1]!);
                insertOn(s, seg[4 * a + 2]!, seg[4 * a + 3]!);
            }
        }
        active.push(s);
    }

    // Loops: each polyline with its contact points inserted, split at its repeated vertices.
    const contours: Contour[] = [];
    const contourOf: number[] = [];
    const orientation: (1 | -1)[] = [];
    const loops: number[][] = [];
    let first = 0;
    polys.forEach((poly, c) => {
        const v: number[] = [];
        for (let i = 0; i < poly.length; i += 2) {
            const [x0, y0] = [poly[i]!, poly[i + 1]!];
            v.push(x0, y0);
            const extra = inserts[first + i / 2];
            if (!extra) continue;
            const pts = Array.from({ length: extra.length / 2 }, (_, k) => [extra[2 * k]!, extra[2 * k + 1]!]);
            pts.sort((p, q) => Math.hypot(p[0]! - x0, p[1]! - y0) - Math.hypot(q[0]! - x0, q[1]! - y0));
            for (const [x, y] of pts) if (x !== v[v.length - 2] || y !== v[v.length - 1]) v.push(x!, y!);
        }
        first += poly.length / 2;
        const kept = splitLoops(v).filter((loop) => loop.length >= 6 && !isFlat(loop));
        if (!kept.length) return;
        for (const loop of kept) {
            // A contour that stays one loop keeps the exact orientation of its curves.
            const area = kept.length === 1 ? doubleArea(flat[c]!) : polygonDoubleArea(loop);
            loops.push(loop);
            contourOf.push(contours.length);
            orientation.push(area >= 0 ? 1 : -1);
        }
        contours.push(flat[c]!);
    });

    const boxes = loops.map((poly) => {
        const xs = poly.filter((_, i) => i % 2 === 0);
        const ys = poly.filter((_, i) => i % 2 === 1);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
    });
    // Loops sharing a vertex touch: all their contacts are shared vertices now.
    const keys = loops.map((poly) => {
        const set = new Set<string>();
        for (let i = 0; i < poly.length; i += 2) set.add(keyOf(poly[i]!, poly[i + 1]!));
        return set;
    });
    const touching = new Set<number>();
    const loopsAt = new Map<string, number[]>();
    keys.forEach((set, l) => {
        for (const k of set) {
            const others = loopsAt.get(k);
            if (!others) loopsAt.set(k, [l]);
            else {
                for (const o of others) touching.add(o * loops.length + l);
                others.push(l);
            }
        }
    });
    const edgeSets: Set<string>[] = [];
    const edgesOf = (l: number): Set<string> => {
        if (edgeSets[l]) return edgeSets[l];
        const poly = loops[l]!;
        const set = new Set<string>();
        for (let i = 0, n = poly.length; i < n; i += 2) {
            const [p, q] = [keyOf(poly[i]!, poly[i + 1]!), keyOf(poly[(i + 2) % n]!, poly[(i + 3) % n]!)];
            set.add(p + ';' + q).add(q + ';' + p);
        }
        return (edgeSets[l] = set);
    };
    /**
     * Where loop a lies relative to the touching loop b. The interior of an edge of a meets no edge of
     * b (contacts are vertices), so it lies inside, outside or along b; the edges at the contact
     * vertices tell, every run of other edges being connected to one of them without meeting b.
     */
    const sideOf = (a: number, b: number): 'in' | 'out' | 'mixed' | 'on' | null => {
        const [poly, other, edges] = [loops[a]!, loops[b]!, edgesOf(b)];
        let inside = false;
        let outside = false;
        for (let i = 0, n = poly.length; i < n; i += 2) {
            if (!keys[b]!.has(keyOf(poly[i]!, poly[i + 1]!))) continue;
            for (const j of [(i + n - 2) % n, i]) {
                const [x1, y1, x2, y2] = [poly[j]!, poly[j + 1]!, poly[(j + 2) % n]!, poly[(j + 3) % n]!];
                if (edges.has(keyOf(x1, y1) + ';' + keyOf(x2, y2))) continue;
                work += other.length / 2;
                if (work > MAX_WORK) return null;
                if (pointInPolygon((x1 + x2) / 2, (y1 + y2) / 2, other)) inside = true;
                else outside = true;
            }
        }
        return inside && outside ? 'mixed' : inside ? 'in' : outside ? 'out' : 'on';
    };

    const containers: number[][] = loops.map(() => []);
    for (let a = 0; a < loops.length; a += 1)
        for (let b = a + 1; b < loops.length; b += 1) {
            const self = contourOf[a] === contourOf[b];
            if (!self && crossIntersects) continue;
            if (touching.has(a * loops.length + b)) {
                const [ab, ba] = [sideOf(a, b), sideOf(b, a)];
                if (!ab || !ba) return null;
                // Partly inside and partly outside (a crossing at a vertex), or the same loop twice.
                if (ab === 'mixed' || ba === 'mixed' || ab === 'on' || ba === 'on' || (ab === 'in' && ba === 'in')) {
                    if (self) return { ...notAnalyzed, selfIntersects: true, crossIntersects };
                    crossIntersects = true;
                    continue;
                }
                if (ab === 'in') containers[a]!.push(b);
                if (ba === 'in') containers[b]!.push(a);
                continue;
            }
            // Disjoint boundaries: b holds a when a's box fits in b's and a vertex of a is inside b.
            for (const [p, q] of [
                [a, b],
                [b, a],
            ] as const) {
                const [px1, py1, px2, py2] = boxes[p]!;
                const [qx1, qy1, qx2, qy2] = boxes[q]!;
                if (px1 < qx1 || py1 < qy1 || px2 > qx2 || py2 > qy2) continue;
                work += loops[q]!.length / 2;
                if (work > MAX_WORK) return null;
                if (pointInPolygon(loops[p]![0]!, loops[p]![1]!, loops[q]!)) containers[p]!.push(q);
            }
        }
    const depth = containers.map((list) => list.length);
    // Nested loops form a chain: the innermost container is the deepest one.
    const parent = containers.map((list) => list.reduce((p, b) => (p < 0 || depth[b]! > depth[p]! ? b : p), -1));
    return { contours, contourOf, orientation, parent, depth, selfIntersects: false, crossIntersects };
}

/**
 * Rewrites an evenodd path into a nonzero path filling the same region, by orienting each loop
 * `orientation·(-1)^depth` (see the section comment above). Without `orientation`, the first top-level
 * loop keeps its own. Contours are reversed whole: a contour split into loops (touching itself) must
 * have its loops already alternating, or reversed all together. Returns `d` itself when every contour
 * is already well oriented, or, without `orientation`, when no loop lies inside another (the winding
 * is then ±1 or 0 everywhere, whatever the orientations). Otherwise M/L/H/V/C/Q/A/Z data, each contour
 * starting with an absolute M (open subpaths closed, empty contours dropped, see `contourPath` for the
 * compact form), its numbers rounded to `precision` decimals (3 by default). Returns null when the
 * contours cross (themselves or each other; touching is fine), or when the path exceeds the caps.
 */
export function evenOddToNonZero(d: string, orientation?: 1 | -1, precision?: number): string | null {
    const a = analyzeContours(d);
    if (!a || a.selfIntersects || a.crossIntersects) return null;
    if (orientation === undefined && a.depth.every((k) => k === 0)) return d;
    const outer = orientation ?? a.orientation[a.depth.indexOf(0)] ?? 1;
    const flip: boolean[] = [];
    for (let l = 0; l < a.orientation.length; l += 1) {
        const wanted = a.depth[l]! % 2 === 0 ? outer : -outer;
        const c = a.contourOf[l]!;
        if (flip[c] !== undefined && flip[c] !== (wanted !== a.orientation[l])) return null;
        flip[c] = wanted !== a.orientation[l];
    }
    if (!flip.some(Boolean)) return d;
    const num = precision === undefined ? fmt : (n: number): string => formatNumber(n, precision);
    return a.contours.map((c, i) => contourPath(flip[i] ? reverseContour(c) : c, num)).join('');
}

/**
 * Number of subpaths of `d` when each one draws at least one segment and is closed by Z, null
 * otherwise (an open subpath, a closepath with nothing to close). A stroke on such a path keeps
 * its geometry when every contour is kept and some are reversed: no caps, the same joins.
 */
export function closedSubpathCount(d: string): number | null {
    let count = 0;
    let open = false;
    for (const { cmd } of toAbsolute(parsePath(d))) {
        if (cmd === 'M') {
            if (open) return null;
        } else if (cmd === 'Z') {
            if (!open) return null;
            count += 1;
            open = false;
        } else open = true;
    }
    return open ? null : count;
}

/**
 * Whether a fill of `d` can cover anything: some subpath has points (end and control points, arcs
 * lowered to cubics) off one line. A Bézier lies in the hull of its control points, so a subpath whose
 * points are all collinear (a line, an open or closed flat polyline) encloses no area, closed by Z or
 * not. Signed area is not used: a figure-eight sums to zero yet fills both lobes.
 */
export function enclosesArea(d: string): boolean {
    let points: number[] = [];
    // Three points at least (six numbers) to span an area.
    const spans = (): boolean => points.length >= 6 && !isFlat(points);
    for (const { cmd, args } of toAbsolute(parsePath(d))) {
        if (cmd === 'M' || cmd === 'Z') {
            if (spans()) return true;
            // After Z, a segment without M starts a new subpath at the closed one's start.
            points = cmd === 'Z' ? points.slice(0, 2) : [];
        }
        if (cmd !== 'Z') points.push(...args);
    }
    return spans();
}

/**
 * Sign of the winding number of a nonzero path where it is not 0: 1 when it is ≥ 0 everywhere, -1
 * when ≤ 0 everywhere. Null when it cannot be proven (self-crossing contours, opposite windings,
 * crossing contours of mixed orientations, caps exceeded) or the path encloses nothing. Concatenating
 * paths of the same sign unites their nonzero regions: windings add up and never cancel.
 */
export function windingSign(d: string): 1 | -1 | null {
    const a = analyzeContours(d);
    if (!a || a.selfIntersects || !a.orientation.length) return null;
    const first = a.orientation[0]!;
    if (a.orientation.every((o) => o === first)) return first;
    if (a.crossIntersects) return null;
    // Nested or disjoint loops (touching allowed): the winding inside a loop is the sum of its chain's orientations.
    const winding: number[] = [];
    const windingOf = (i: number): number =>
        (winding[i] ??= a.orientation[i]! + (a.parent[i]! < 0 ? 0 : windingOf(a.parent[i]!)));
    const values = a.orientation.map((_, i) => windingOf(i));
    if (values.every((w) => w >= 0)) return 1;
    if (values.every((w) => w <= 0)) return -1;
    return null;
}

/**
 * The same path in compact form (see `contourPath`), its numbers rounded to `precision` decimals (3 by
 * default): open subpaths closed and empty ones dropped, so only fills (and clips) keep their region.
 * An empty string when no contour draws anything.
 */
export function compactPathData(d: string, precision?: number): string {
    const num = precision === undefined ? fmt : (n: number): string => formatNumber(n, precision);
    return contoursOf(d)
        .map((c) => contourPath(c, num))
        .join('');
}

/** The path traversed backwards (compact contours, open subpaths closed): same nonzero region, opposite winding. */
export function reversePathData(d: string): string {
    return contoursOf(d)
        .map((c) => contourPath(reverseContour(c)))
        .join('');
}
