import type { Command } from './pathParse.js';

/** Lowering of a parsed path to absolute M/L/C/Q/Z commands (H/V→L, S→C, T→Q, A→cubics). */

/** Mutable running state shared by the walkers (current point + last subpath start). */
interface PenState {
    x: number;
    y: number;
    startX: number;
    startY: number;
}

/** Rounds to 3 decimals and trims trailing zeros: 2.000 → "2", 2.500 → "2.5", -0 → "0". */
export function fmt(n: number): string {
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
export interface AbsCommand {
    cmd: 'M' | 'L' | 'C' | 'Q' | 'Z';
    args: number[];
}

/**
 * Normalizes a path to absolute M/L/C/Q/Z. Relative commands are accumulated, H/V become L,
 * S becomes C (reflecting the previous cubic control point), T becomes Q (reflecting the previous
 * quadratic control point) and A becomes one or more C. The current/start point and the two
 * "last control point" trackers are threaded through so smooth-curve reflection stays correct.
 */
export function toAbsolute(commands: Command[]): AbsCommand[] {
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
