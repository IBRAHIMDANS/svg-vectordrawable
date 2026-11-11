import { fmt, toAbsolute } from './pathAbsolute.js';
import { parsePath } from './pathParse.js';
import { applyPoint, type Matrix } from './transform.js';

export { pathBBox } from './pathBBox.js';
export { evenOddToNonZero, reversePathData, windingSign } from './pathContours.js';
export { normalizeArcFlags } from './pathParse.js';

/**
 * Pure SVG path-data manipulation: geometric bounding box and affine transform.
 *
 * Everything works on the `d` attribute string only — no DOM, no svgo. The transform pipeline
 * normalizes a path to absolute commands, lowers H/V→L, S→C, T→Q and A→cubic Béziers, then maps
 * every coordinate through a {@link Matrix}. That keeps the output representable as plain
 * M/L/C/Q/Z, which is all an Android VectorDrawable path needs.
 */

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
