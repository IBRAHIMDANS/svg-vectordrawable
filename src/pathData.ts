import { applyPoint, type Matrix } from './transform.js';

/**
 * Pure SVG path-data manipulation: geometric bounding box and affine transform.
 *
 * Everything works on the `d` attribute string only — no DOM, no svgo. The transform pipeline
 * normalizes a path to absolute commands, lowers H/V→L, S→C, T→Q and A→cubic Béziers, then maps
 * every coordinate through a {@link Matrix}. That keeps the output representable as plain
 * M/L/C/Q/Z, which is all an Android VectorDrawable path needs.
 */

/** One parsed path command: the (uppercase, absolute-or-relative) letter plus its raw numbers. */
interface Command {
    /** Command letter as written, e.g. 'M', 'm', 'c', 'A'. Case encodes absolute vs relative. */
    cmd: string;
    /** Flat list of numeric arguments exactly as parsed. */
    args: number[];
}

/** Number of arguments each command consumes per repetition. Z/z take none. */
const ARG_COUNT: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    A: 7,
    Z: 0,
};

/** Positions of the large-arc and sweep flags inside one A/a argument group. */
const ARC_FLAG_INDEXES = new Set([3, 4]);

/** A full path-data number token (same grammar as the tokenizer's number branch). */
const NUMBER_TOKEN_RE = /^-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?$/;

/**
 * Splits a compact arc-flag token. SVG flags are single characters (`0`/`1`) and need no separator,
 * so `0120` means flag 0, then `120` (itself flag 1 then `20`), and `01` means flags 0 and 1.
 * Returns null when the token is a single character or does not start with a flag followed by a
 * valid number, in which case the caller keeps the token as a plain number.
 */
function splitArcFlag(token: string): { flag: number; rest: string } | null {
    if (token.length < 2 || (token[0] !== '0' && token[0] !== '1')) return null;
    const rest = token.slice(1);
    if (!NUMBER_TOKEN_RE.test(rest)) return null;
    return { flag: Number(token[0]), rest };
}

/** Source span `[start, end)` of one arc flag inside the original path-data string. */
interface FlagSpan {
    start: number;
    end: number;
}

/**
 * Tokenizes a path-data string into commands, splitting repeated argument groups into separate
 * commands (e.g. `M0 0 1 1` → an M then an implicit L, per the SVG spec). Returns [] on garbage.
 * When `flagSpans` is given, the source span of every arc flag of a complete A/a group is appended.
 */
function parsePath(d: string, flagSpans?: FlagSpan[]): Command[] {
    const commands: Command[] = [];
    // Match a command letter or a number (incl. scientific notation, leading sign, dot).
    const tokenRe = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
    const tokens: string[] = [];
    // Source offset of each token, kept in sync when a compact arc flag is split off.
    const offsets: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(d)) !== null) {
        tokens.push(match[1] ?? match[2]!);
        offsets.push(match.index);
    }

    let i = 0;
    let prevCmd = '';
    while (i < tokens.length) {
        const tok = tokens[i]!;
        let cmd: string;
        if (/[a-zA-Z]/.test(tok)) {
            cmd = tok;
            i += 1;
        } else {
            // Bare number with no leading letter: only valid if a previous command can repeat.
            if (!prevCmd) break;
            // After an explicit moveto, subsequent coordinate pairs are implicit linetos.
            cmd = prevCmd === 'M' ? 'L' : prevCmd === 'm' ? 'l' : prevCmd;
        }

        const upper = cmd.toUpperCase();
        const count = ARG_COUNT[upper];
        if (count === undefined) break; // unknown command letter → bail out

        if (count === 0) {
            commands.push({ cmd, args: [] });
            prevCmd = cmd;
            continue;
        }

        // Consume `count` numbers; stop if the path ends mid-group (malformed).
        const args: number[] = [];
        const spans: FlagSpan[] = [];
        for (let k = 0; k < count; k += 1) {
            const next = tokens[i];
            if (next === undefined || /[a-zA-Z]/.test(next)) break;
            if (upper === 'A' && ARC_FLAG_INDEXES.has(k)) {
                const split = splitArcFlag(next);
                if (split) {
                    args.push(split.flag);
                    spans.push({ start: offsets[i]!, end: offsets[i]! + 1 });
                    // The rest of the token is re-read as the next argument(s).
                    tokens[i] = split.rest;
                    offsets[i] = offsets[i]! + 1;
                    continue;
                }
                spans.push({ start: offsets[i]!, end: offsets[i]! + next.length });
            }
            args.push(Number(next));
            i += 1;
        }
        if (args.length < count) break; // incomplete final command
        commands.push({ cmd, args });
        flagSpans?.push(...spans);
        prevCmd = cmd;
    }

    return commands;
}

/** Characters that already separate two path-data arguments. */
const SEPARATOR_RE = /[\s,]/;

/**
 * Rewrites only the large-arc and sweep flags of A/a commands so each is separated from its
 * neighbours (e.g. `a10 10 0 0120 0` → `a10 10 0 0 1 20 0`). SVG allows compact flags without
 * separators, but some Android API levels' PathParser misread them as one number. A single space is
 * inserted only where a flag touches another token; every other character is kept, so a path
 * without arcs (or with already separated flags) is returned unchanged.
 */
export function normalizeArcFlags(d: string): string {
    const spans: FlagSpan[] = [];
    parsePath(d, spans);
    const cuts = new Set<number>();
    for (const { start, end } of spans) {
        if (start > 0 && !SEPARATOR_RE.test(d[start - 1]!)) cuts.add(start);
        if (end < d.length && !SEPARATOR_RE.test(d[end]!)) cuts.add(end);
    }
    if (cuts.size === 0) return d;
    let out = '';
    let last = 0;
    for (const cut of [...cuts].sort((a, b) => a - b)) {
        out += `${d.slice(last, cut)} `;
        last = cut;
    }
    return out + d.slice(last);
}

/** Mutable running state shared by the walkers (current point + last subpath start). */
interface PenState {
    x: number;
    y: number;
    startX: number;
    startY: number;
}

/**
 * Parameters in (0,1) where a 1D Bézier component has a local extremum. Takes the derivative's
 * quadratic coefficients `a·t² + b·t + c` (a = 0 for quadratic curves, whose derivative is linear).
 */
function derivativeRoots(a: number, b: number, c: number): number[] {
    const roots: number[] = [];
    if (Math.abs(a) < 1e-12) {
        if (Math.abs(b) > 1e-12) roots.push(-c / b);
    } else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
            const sq = Math.sqrt(disc);
            roots.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
        }
    }
    return roots.filter((t) => t > 0 && t < 1);
}

/** Extremum parameters of one cubic component p0..p3 (derivative coefficients of B'(t)/3). */
const cubicExtrema = (p0: number, p1: number, p2: number, p3: number): number[] =>
    derivativeRoots(-p0 + 3 * p1 - 3 * p2 + p3, 2 * (p0 - 2 * p1 + p2), p1 - p0);

const cubicAt = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const quadAt = (t: number, p0: number, p1: number, p2: number): number => {
    const u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
};

/**
 * Geometric (tight) bounding box of a path, as SVG defines it for `objectBoundingBox`: curve
 * extrema are solved exactly, never approximated by control points, and arcs are measured through
 * their cubic lowering. Returns null when the path has no drawable geometry.
 */
export function pathBBox(d: string): { x: number; y: number; width: number; height: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let seen = false;

    const include = (x: number, y: number): void => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        seen = true;
    };

    let px = 0;
    let py = 0;
    let startX = 0;
    let startY = 0;
    for (const { cmd, args: g } of toAbsolute(parsePath(d))) {
        if (cmd === 'Z') {
            px = startX;
            py = startY;
            continue;
        }
        if (cmd === 'C') {
            for (const t of cubicExtrema(px, g[0]!, g[2]!, g[4]!)) include(cubicAt(t, px, g[0]!, g[2]!, g[4]!), py);
            for (const t of cubicExtrema(py, g[1]!, g[3]!, g[5]!)) include(px, cubicAt(t, py, g[1]!, g[3]!, g[5]!));
        } else if (cmd === 'Q') {
            for (const t of derivativeRoots(0, px - 2 * g[0]! + g[2]!, g[0]! - px))
                include(quadAt(t, px, g[0]!, g[2]!), py);
            for (const t of derivativeRoots(0, py - 2 * g[1]! + g[3]!, g[1]! - py))
                include(px, quadAt(t, py, g[1]!, g[3]!));
        }
        px = g[g.length - 2]!;
        py = g[g.length - 1]!;
        if (cmd === 'M') {
            startX = px;
            startY = py;
        }
        include(px, py);
    }

    if (!seen) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Rounds to 3 decimals and trims trailing zeros: 2.000 → "2", 2.500 → "2.5", -0 → "0". */
function fmt(n: number): string {
    if (!Number.isFinite(n)) return '0';
    let r = Math.round(n * 1000) / 1000;
    if (Object.is(r, -0)) r = 0;
    // toFixed(3) then strip trailing zeros and any dangling decimal point.
    let s = r.toFixed(3).replace(/\.?0+$/, '');
    if (s === '' || s === '-') s = '0';
    return s;
}

/** Reflects the previous control point about the current point (for S/T smooth curves). */
function reflect(curr: number, prevControl: number): number {
    return 2 * curr - prevControl;
}

/**
 * Converts a single SVG elliptical arc into a sequence of cubic Bézier segments.
 *
 * Standard endpoint→center parameterization (SVG implementation notes F.6), then the sweep is
 * split into pieces of at most 90° and each piece approximated by one cubic. Returns the cubic
 * control/end points in absolute user space as flat [c1x,c1y,c2x,c2y,x,y, …].
 */
function arcToCubics(
    x1: number,
    y1: number,
    rxIn: number,
    ryIn: number,
    phiDeg: number,
    largeArc: boolean,
    sweep: boolean,
    x2: number,
    y2: number,
): number[] {
    // Degenerate radii or zero-length arc → straight line (single trivial cubic).
    if (rxIn === 0 || ryIn === 0 || (x1 === x2 && y1 === y2)) {
        return [x1, y1, x2, y2, x2, y2];
    }

    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    const phi = (phiDeg * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    // Step 1: transform endpoints into the ellipse's coordinate frame (midpoint at origin).
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cosPhi * dx + sinPhi * dy;
    const y1p = -sinPhi * dx + cosPhi * dy;

    // Correct out-of-range radii so the ellipse can span the chord (notes F.6.6).
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s;
        ry *= s;
    }

    // Step 2: compute the center in the transformed frame.
    const rxSq = rx * rx;
    const rySq = ry * ry;
    const x1pSq = x1p * x1p;
    const y1pSq = y1p * y1p;
    let num = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
    if (num < 0) num = 0; // guard against tiny negative from rounding
    const denom = rxSq * y1pSq + rySq * x1pSq;
    let coef = denom === 0 ? 0 : Math.sqrt(num / denom);
    if (largeArc === sweep) coef = -coef;
    const cxp = (coef * (rx * y1p)) / ry;
    const cyp = (coef * -(ry * x1p)) / rx;

    // Step 3: center back in user space.
    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

    // Step 4: start angle and sweep angle.
    const angle = (ux: number, uy: number, vx: number, vy: number): number => {
        const dot = ux * vx + uy * vy;
        const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
        let a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
        if (ux * vy - uy * vx < 0) a = -a;
        return a;
    };
    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let deltaTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
    else if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

    // Step 5: split into ≤90° segments, each approximated by one cubic.
    const segCount = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
    const delta = deltaTheta / segCount;
    // Magic constant: control-point distance for a unit-circle arc of angle `delta`.
    const t = (4 / 3) * Math.tan(delta / 4);

    const out: number[] = [];
    let theta = theta1;
    // Point + tangent on the (rotated, translated) ellipse at parameter `a`.
    const pointAt = (a: number): { x: number; y: number; dxA: number; dyA: number } => {
        const cosA = Math.cos(a);
        const sinA = Math.sin(a);
        const ex = cosPhi * rx * cosA - sinPhi * ry * sinA + cx;
        const ey = sinPhi * rx * cosA + cosPhi * ry * sinA + cy;
        // Derivative w.r.t. a (tangent direction).
        const dxA = -cosPhi * rx * sinA - sinPhi * ry * cosA;
        const dyA = -sinPhi * rx * sinA + cosPhi * ry * cosA;
        return { x: ex, y: ey, dxA, dyA };
    };

    for (let s = 0; s < segCount; s += 1) {
        const p1 = pointAt(theta);
        const thetaNext = theta + delta;
        const p2 = pointAt(thetaNext);
        const c1x = p1.x + t * p1.dxA;
        const c1y = p1.y + t * p1.dyA;
        const c2x = p2.x - t * p2.dxA;
        const c2y = p2.y - t * p2.dyA;
        out.push(c1x, c1y, c2x, c2y, p2.x, p2.y);
        theta = thetaNext;
    }

    return out;
}

/** A lowered, absolute command: only M/L/C/Q/Z, all coordinates absolute. */
interface AbsCommand {
    cmd: 'M' | 'L' | 'C' | 'Q' | 'Z';
    args: number[];
}

/**
 * Normalizes a path to absolute M/L/C/Q/Z. Relative commands are accumulated, H/V become L,
 * S becomes C (reflecting the previous cubic control point), T becomes Q (reflecting the previous
 * quadratic control point) and A becomes one or more C. The current/start point and the two
 * "last control point" trackers are threaded through so smooth-curve reflection stays correct.
 */
function toAbsolute(commands: Command[]): AbsCommand[] {
    const out: AbsCommand[] = [];
    const pen: PenState = { x: 0, y: 0, startX: 0, startY: 0 };
    // Last cubic/quadratic control points, in absolute space, for S/T reflection.
    let lastCubicCx: number | null = null;
    let lastCubicCy: number | null = null;
    let lastQuadCx: number | null = null;
    let lastQuadCy: number | null = null;

    for (const { cmd, args } of commands) {
        const abs = cmd === cmd.toUpperCase();
        const upper = cmd.toUpperCase();
        const ox = abs ? 0 : pen.x;
        const oy = abs ? 0 : pen.y;
        // Whether this command produces a smooth curve; if not, reflection trackers reset below.
        let producedCubic = false;
        let producedQuad = false;

        switch (upper) {
            case 'M': {
                pen.x = ox + args[0]!;
                pen.y = oy + args[1]!;
                pen.startX = pen.x;
                pen.startY = pen.y;
                out.push({ cmd: 'M', args: [pen.x, pen.y] });
                break;
            }
            case 'L': {
                pen.x = ox + args[0]!;
                pen.y = oy + args[1]!;
                out.push({ cmd: 'L', args: [pen.x, pen.y] });
                break;
            }
            case 'H': {
                pen.x = ox + args[0]!;
                out.push({ cmd: 'L', args: [pen.x, pen.y] });
                break;
            }
            case 'V': {
                pen.y = oy + args[0]!;
                out.push({ cmd: 'L', args: [pen.x, pen.y] });
                break;
            }
            case 'C': {
                const c1x = ox + args[0]!;
                const c1y = oy + args[1]!;
                const c2x = ox + args[2]!;
                const c2y = oy + args[3]!;
                pen.x = ox + args[4]!;
                pen.y = oy + args[5]!;
                out.push({ cmd: 'C', args: [c1x, c1y, c2x, c2y, pen.x, pen.y] });
                lastCubicCx = c2x;
                lastCubicCy = c2y;
                producedCubic = true;
                break;
            }
            case 'S': {
                // First control point is the reflection of the previous cubic's second control.
                const c1x = lastCubicCx !== null ? reflect(pen.x, lastCubicCx) : pen.x;
                const c1y = lastCubicCy !== null ? reflect(pen.y, lastCubicCy) : pen.y;
                const c2x = ox + args[0]!;
                const c2y = oy + args[1]!;
                pen.x = ox + args[2]!;
                pen.y = oy + args[3]!;
                out.push({ cmd: 'C', args: [c1x, c1y, c2x, c2y, pen.x, pen.y] });
                lastCubicCx = c2x;
                lastCubicCy = c2y;
                producedCubic = true;
                break;
            }
            case 'Q': {
                const cqx = ox + args[0]!;
                const cqy = oy + args[1]!;
                pen.x = ox + args[2]!;
                pen.y = oy + args[3]!;
                out.push({ cmd: 'Q', args: [cqx, cqy, pen.x, pen.y] });
                lastQuadCx = cqx;
                lastQuadCy = cqy;
                producedQuad = true;
                break;
            }
            case 'T': {
                // Control point is the reflection of the previous quadratic's control.
                const tcx: number = lastQuadCx !== null ? reflect(pen.x, lastQuadCx) : pen.x;
                const tcy: number = lastQuadCy !== null ? reflect(pen.y, lastQuadCy) : pen.y;
                pen.x = ox + args[0]!;
                pen.y = oy + args[1]!;
                out.push({ cmd: 'Q', args: [tcx, tcy, pen.x, pen.y] });
                lastQuadCx = tcx;
                lastQuadCy = tcy;
                producedQuad = true;
                break;
            }
            case 'A': {
                const x2 = ox + args[5]!;
                const y2 = oy + args[6]!;
                const cubics = arcToCubics(
                    pen.x,
                    pen.y,
                    args[0]!,
                    args[1]!,
                    args[2]!,
                    args[3]! !== 0,
                    args[4]! !== 0,
                    x2,
                    y2,
                );
                for (let k = 0; k + 5 < cubics.length; k += 6) {
                    out.push({
                        cmd: 'C',
                        args: [
                            cubics[k]!,
                            cubics[k + 1]!,
                            cubics[k + 2]!,
                            cubics[k + 3]!,
                            cubics[k + 4]!,
                            cubics[k + 5]!,
                        ],
                    });
                }
                pen.x = x2;
                pen.y = y2;
                break;
            }
            case 'Z': {
                pen.x = pen.startX;
                pen.y = pen.startY;
                out.push({ cmd: 'Z', args: [] });
                break;
            }
        }

        // Reset reflection trackers when the command was not the matching curve type.
        if (!producedCubic) {
            lastCubicCx = null;
            lastCubicCy = null;
        }
        if (!producedQuad) {
            lastQuadCx = null;
            lastQuadCy = null;
        }
    }

    return out;
}

/**
 * Applies an affine matrix to a path and returns a new path string in absolute commands only
 * (M/L/C/Q/Z). The path is first lowered (see {@link toAbsolute}: H/V→L, S→C, T→Q, A→cubics),
 * then every coordinate pair is mapped through `m`. Numbers are rounded to 3 decimals with
 * trailing zeros trimmed.
 */
export function transformPathData(d: string, m: Matrix): string {
    const absCommands = toAbsolute(parsePath(d));
    const parts: string[] = [];

    for (const { cmd, args } of absCommands) {
        if (cmd === 'Z') {
            parts.push('Z');
            continue;
        }
        const mapped: string[] = [];
        for (let k = 0; k + 1 < args.length; k += 2) {
            const [tx, ty] = applyPoint(m, args[k]!, args[k + 1]!);
            mapped.push(fmt(tx), fmt(ty));
        }
        parts.push(cmd + mapped.join(' '));
    }

    return parts.join('');
}

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
                ? Math.max(Math.hypot(x0 - 2 * ax! + bx!, y0 - 2 * ay! + by!), Math.hypot(ax! - 2 * bx! + x3, ay! - 2 * by! + y3))
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
                const [ax, ay, bx, by, cx, cy, ex, ey] = pair as [number, number, number, number, number, number, number, number];
                const [ux, uy, vx, vy] = [bx - ax, by - ay, ex - cx, ey - cy];
                if (Math.abs(ux * vy - uy * vx) <= 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy < 0)
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
