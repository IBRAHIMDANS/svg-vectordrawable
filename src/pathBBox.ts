import { toAbsolute } from './pathAbsolute.js';
import { parsePath } from './pathParse.js';

/** Geometric bounding box of a path (curve extrema included), and Bézier evaluation helpers. */

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

export const cubicAt = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

export const quadAt = (t: number, p0: number, p1: number, p2: number): number => {
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
