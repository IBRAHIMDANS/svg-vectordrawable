import { _collections } from './svgo.js';
import type { AndroidColor } from './types.js';

// svgo ships the CSS named-color table (e.g. `red` → `#f00`); reuse it instead of maintaining one.
const NAMED: Record<string, string> = {
    ...((_collections as { colorsNames?: Record<string, string> }).colorsNames ?? {}),
    transparent: 'rgba(0,0,0,0)',
};

interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);
const hex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

function hslToRgb(h: number, s: number, l: number): Rgba {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    // Every branch below assigns all three channels.
    let r: number;
    let g: number;
    let b: number;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}

function parseRgba(raw: string, currentColor: string, seen = 0): Rgba | null {
    if (seen > 4) return null; // guard against currentColor → currentColor loops
    const value = raw.trim().toLowerCase();

    if (value === 'none') return null;
    if (value === 'currentcolor') return parseRgba(currentColor, currentColor, seen + 1);

    if (value.startsWith('#')) {
        const h = value.slice(1);
        const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
        if (h.length === 3 || h.length === 4) {
            return {
                r: expand(h[0]!),
                g: expand(h[1]!),
                b: expand(h[2]!),
                a: h.length === 4 ? expand(h[3]!) / 255 : 1,
            };
        }
        if (h.length === 6 || h.length === 8) {
            return {
                r: parseInt(h.slice(0, 2), 16),
                g: parseInt(h.slice(2, 4), 16),
                b: parseInt(h.slice(4, 6), 16),
                a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
            };
        }
        return null;
    }

    const fn = value.match(/^(rgba?|hsla?)\(([^)]+)\)$/);
    if (fn) {
        const kind = fn[1]!;
        const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
        const num = (s: string | undefined): number => parseFloat(s ?? '0');
        const alpha = parts[3] !== undefined ? (parts[3].endsWith('%') ? num(parts[3]) / 100 : num(parts[3])) : 1;
        if (kind.startsWith('rgb')) {
            const ch = (s: string | undefined): number => (s?.endsWith('%') ? (num(s) / 100) * 255 : num(s));
            return { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: alpha };
        }
        const rgb = hslToRgb(num(parts[0]), num(parts[1]) / 100, num(parts[2]) / 100);
        return { ...rgb, a: alpha };
    }

    if (value in NAMED) return parseRgba(NAMED[value]!, currentColor, seen + 1);
    return null;
}

/**
 * Converts an SVG color (`#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()`, `hsl()/hsla()`, named,
 * `currentColor`, `transparent`) plus an optional extra opacity into an Android `#AARRGGBB`.
 * Returns `null` for `none` / unparseable values (i.e. "no paint").
 */
export function toAndroidColor(
    value: string | undefined,
    opacity: number | undefined,
    currentColor: string,
): AndroidColor | null {
    if (value === undefined) return null;
    const rgba = parseRgba(value, currentColor);
    if (!rgba) return null;
    const a = clamp(rgba.a * (opacity ?? 1), 0, 1);
    return `#${hex2(a * 255)}${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`.toUpperCase() as AndroidColor;
}
