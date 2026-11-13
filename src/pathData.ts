import { fmt, toAbsolute } from './pathAbsolute.js';
import { parsePath } from './pathParse.js';
import { applyPoint, type Matrix } from './transform.js';
import { inFloatRange } from './units.js';

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

/** Arguments per group of each path command (SVG 2 §9.3.9 grammar). */
const GROUP_SIZE: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
/** `wsp` of the path-data grammar. */
const WSP = new Set([' ', '\t', '\n', '\f', '\r']);
/** One path-data number (an exponent counts only with its digits). Sticky: matched at `lastIndex`. */
const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
/** Characters a number can start with: an argument group follows when the next character is one. */
const NUMBER_START_RE = /[+\-.\d]/;

/**
 * Applies SVG 2 path-data error handling (§9.5.4): the path is rendered up to the last command
 * group that is fully valid, and data that does not start with a moveto renders nothing. Returns
 * `d` itself when it is entirely valid (byte for byte, so valid input is never rewritten), its
 * valid prefix otherwise (`M10 10 L20 20 L` → `M10 10 L20 20`), or null when what remains draws no
 * segment (empty, garbage, no leading moveto, movetos only). svgo's `parsePathData` follows the
 * same rule, so both `optimize` modes keep the same geometry.
 */
export function validPathData(d: string): string | null {
    const n = d.length;
    let i = 0;
    /** End of the last complete command group: the valid prefix is `d.slice(0, end)`. */
    let end = 0;
    let drawable = false;

    const skipWsp = (): void => {
        while (i < n && WSP.has(d[i]!)) i += 1;
    };
    /** Skips a `comma_wsp`; true when it held a comma (an argument must follow then). */
    const skipCommaWsp = (): boolean => {
        skipWsp();
        if (d[i] !== ',') return false;
        i += 1;
        skipWsp();
        return true;
    };
    const readNumber = (): boolean => {
        NUMBER_RE.lastIndex = i;
        const m = NUMBER_RE.exec(d);
        // A number a float cannot hold (`1e39`, `1e400`) is an error: browsers draw up to it.
        if (!m || !inFloatRange(Number(m[0]))) return false;
        i += m[0].length;
        return true;
    };
    /** Reads one argument group of `upper` starting at `i` (separators inside the group only). */
    const readGroup = (upper: string): boolean => {
        for (let k = 0; k < GROUP_SIZE[upper]!; k += 1) {
            if (k > 0) skipCommaWsp();
            if (upper === 'A' && (k === 3 || k === 4)) {
                // Arc flags are a single character, no separator needed after them.
                if (d[i] !== '0' && d[i] !== '1') return false;
                i += 1;
            } else if (!readNumber()) return false;
        }
        return true;
    };
    const complete = (upper: string): void => {
        end = i;
        if (upper !== 'M') drawable = true;
    };

    let started = false;
    let valid = true;
    scan: while (true) {
        skipWsp();
        if (i >= n) break;
        const letter = d[i]!;
        const upper = letter.toUpperCase();
        if (!/[a-z]/i.test(letter) || GROUP_SIZE[upper] === undefined || (!started && upper !== 'M')) {
            valid = false;
            break;
        }
        started = true;
        i += 1;
        if (upper === 'Z') {
            complete(upper);
            continue;
        }
        skipWsp();
        if (!readGroup(upper)) {
            valid = false;
            break;
        }
        complete(upper);
        // Repeated groups; those after a moveto are implicit linetos.
        const repeat = upper === 'M' ? 'L' : upper;
        while (true) {
            const save = i;
            const comma = skipCommaWsp();
            if (i < n && NUMBER_START_RE.test(d[i]!)) {
                if (!readGroup(repeat)) {
                    valid = false;
                    break scan;
                }
                complete(repeat);
            } else if (comma) {
                valid = false; // a comma not followed by an argument
                break scan;
            } else {
                i = save;
                break;
            }
        }
    }

    if (!drawable) return null;
    return valid ? d : d.slice(0, end);
}

/**
 * Applies an affine matrix to a path and returns a new path string in absolute commands only
 * (M/L/C/Q/Z). The path is first lowered (see {@link toAbsolute}: H/V→L, S→C, T→Q, A→cubics),
 * then every coordinate pair is mapped through `m`. Numbers are rounded to `precision` decimals
 * (3 by default) with trailing zeros trimmed.
 */
export function transformPathData(d: string, m: Matrix, precision = 3): string {
    const format = precision === 3 ? fmt : (v: number): string => fmtAt(v, precision);
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
            mapped.push(format(tx), format(ty));
        }
        parts.push(cmd + mapped.join(' '));
    }

    return parts.join('');
}

/** Like `fmt`, at `precision` decimals (0 to 20): no exponent, trailing zeros trimmed, -0 → "0". */
function fmtAt(n: number, precision: number): string {
    if (!Number.isFinite(n)) return '0';
    const p = Math.min(Math.max(Math.round(precision), 0), 20);
    let s = (Math.round(n * 10 ** p) / 10 ** p).toFixed(p);
    if (s.includes('.')) s = s.replace(/\.?0+$/, '');
    return s === '' || /^-0?$/.test(s) ? '0' : s;
}

/**
 * Precision of coordinates drawn under a scale of `scale`: they are multiplied by it on screen, so
 * they keep `ceil(log10(scale))` more decimals than `precision` (at most 20). Unchanged under a
 * scale of 1 or less.
 */
export function scaledPrecision(precision: number, scale: number): number {
    const extra = scale > 1 ? Math.ceil(Math.log10(scale) - 1e-9) : 0;
    return Math.min(precision + extra, 20);
}

/** Largest factor by which `m` scales lengths along an axis (the longer of its column vectors). */
export function matrixScale(m: Matrix): number {
    return Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
}
