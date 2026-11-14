/**
 * VectorDrawable → SVG preview: re-serializes a VectorDrawable XML string into a standalone SVG string
 * that renders the same picture, to preview a drawable in a browser, an image viewer or a PR review.
 *
 * Android semantics reproduced here (AndroidX `VectorDrawableCompat` / framework `VectorDrawable`):
 * - `<vector>`: the viewport is stretched to width × height (no aspect preservation), `android:alpha`
 *   applies to the whole drawing. `android:tint` / `android:tintMode` are ignored unless
 *   {@link PreviewOptions.applyTint} is set (the default `src_in` mode recolors every pixel).
 * - `<group>`: local matrix = T(translate + pivot) · R(rotation) · S(scale) · T(−pivot), i.e. Android
 *   applies scale → rotate → translate around the pivot.
 * - `<clip-path>`: clips every *subsequent* sibling of its group (and their descendants); several
 *   clip-paths in a group, or nested groups, intersect. Clip paths use the non-zero rule.
 * - `<path>`: no fill unless `fillColor`; no stroke unless `strokeColor` and `strokeWidth` > 0;
 *   `fillAlpha` / `strokeAlpha` multiply the color alpha (or the gradient); defaults butt / miter / 4.
 * - `<aapt:attr name="android:fillColor|strokeColor"><gradient>`: linear / radial gradients in the
 *   path's coordinate space (= SVG `userSpaceOnUse`), `tileMode` clamp / repeated / mirror.
 * - Color references (`@[package:]color/name`, `?[package:]attr/name`, as produced by the converter's
 *   `currentColor` / `colorMap` options) have no value outside an app: they take the color given in
 *   {@link PreviewOptions.colors}, otherwise {@link UNRESOLVED_COLOR} (neutral gray), reported through
 *   {@link PreviewOptions.onUnresolvedColor}.
 * - `trimPathStart` / `trimPathEnd` / `trimPathOffset` (never produced by the converter): see
 *   {@link trimWindow}. Rendered on a stroke-only path (`stroke-dasharray` over the measured contour); a
 *   *filled* trimmed path is drawn whole ({@link hasUnrenderedTrim}), since Android fills the trimmed
 *   geometry and SVG has no equivalent.
 *
 * Unsupported input throws an `Error` naming the construct: sweep gradients (no SVG equivalent),
 * malformed colors, unknown elements, malformed XML, a missing or non-positive viewport.
 *
 * Deliberately self-contained (its own tiny XML parser, no import from the converter): the test
 * harness uses it to validate the converter's output, so a converter bug cannot be masked by shared
 * code. It has no Node-only dependency and is exported from the browser entry too.
 */

/** Options of {@link vectorDrawableToSvg}. */
export interface PreviewOptions {
    /**
     * Pixels per dp for the SVG `width` / `height` (default `1`, i.e. mdpi: `24dp` → `24`). Use e.g.
     * `4` for an xxxhdpi-sized preview. The viewBox is the vector's viewport whatever the density.
     */
    density?: number;
    /**
     * Apply the vector's `android:tint` (color literal, or reference resolved like any color) with its
     * `android:tintMode` (default `src_in`; `src_over`, `src_atop`, `multiply`, `screen`, `add`
     * supported) as an SVG filter.
     * Default `false`: the tint is ignored and the drawing keeps its own colors.
     */
    applyTint?: boolean;
    /**
     * Preview values of the color references of the drawable, e.g.
     * `{ '?attr/colorPrimary': '#6750A4', '@color/brand': '#801A73E8' }`. Keys are references written
     * exactly as in the XML; values are Android color literals (`#RGB`, `#ARGB`, `#RRGGBB`,
     * `#AARRGGBB`: alpha first, as in `res/values/colors.xml`). A malformed key or value throws a
     * `TypeError`. A reference missing from the map is drawn in {@link UNRESOLVED_COLOR}.
     */
    colors?: Readonly<Record<string, string>>;
    /**
     * Called once per distinct color reference that `colors` does not resolve (drawn in
     * {@link UNRESOLVED_COLOR}), in order of appearance, after the preview is built.
     */
    onUnresolvedColor?: (reference: string) => void;
}

/** Color of a reference missing from {@link PreviewOptions.colors} (Android literal, opaque mid gray). */
export const UNRESOLVED_COLOR = '#FF808080';

/** A resource / package name (same grammar as the converter's `src/colorRef.ts`, kept independent). */
const NAME = '[a-zA-Z_][a-zA-Z0-9_.]*';

/** `@[package:]color/name` or `?[package:]attr/name`. */
const REFERENCE_RE = new RegExp(`^(?:@(?:${NAME}:)?color|\\?(?:${NAME}:)?attr)/${NAME}$`);

/** A parsed XML element of the restricted VectorDrawable format. */
export interface XmlNode {
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            if (!(code <= 0x10ffff)) throw new Error(`Invalid character reference ${m}`);
            return String.fromCodePoint(code);
        }
        return ENTITIES[e] ?? m;
    });
}

/**
 * Minimal XML parser for the VectorDrawable subset: elements, attributes, self-closing tags,
 * comments, XML declaration. Text content is ignored (a VectorDrawable has none).
 * @internal
 */
export function parseXml(xml: string): XmlNode {
    const root: XmlNode = { name: '#root', attrs: {}, children: [] };
    const stack: XmlNode[] = [root];
    const tagRe =
        /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
    const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(xml)) !== null) {
        const [, closing, name, rawAttrs, selfClosing] = m;
        if (name === undefined) continue; // comment / declaration / CDATA
        const parent = stack[stack.length - 1]!;
        if (closing) {
            if (parent.name !== name) throw new Error(`Mismatched </${name}> (open: <${parent.name}>)`);
            stack.pop();
            continue;
        }
        const attrs: Record<string, string> = {};
        let a: RegExpExecArray | null;
        attrRe.lastIndex = 0;
        while ((a = attrRe.exec(rawAttrs ?? '')) !== null) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
        const node: XmlNode = { name, attrs, children: [] };
        parent.children.push(node);
        if (!selfClosing) stack.push(node);
    }
    if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1]!.name}>`);
    const top = root.children[0];
    if (!top) throw new Error('Empty XML document');
    return top;
}

/** A color resolved to SVG `rgb` + opacity. */
interface SvgColor {
    rgb: string;
    opacity: number;
}

/**
 * Parses an Android color literal: `#RGB`, `#ARGB`, `#RRGGBB`, `#AARRGGBB`.
 * @internal
 */
export function parseAndroidColor(value: string): SvgColor {
    const hex = value.trim().replace(/^#/, '');
    if (!/^[0-9a-f]+$/i.test(hex)) throw new Error(`Unsupported Android color: ${value}`);
    let a = 'ff';
    let rgb: string;
    switch (hex.length) {
        case 3:
            rgb = hex.replace(/./g, (c) => c + c);
            break;
        case 4:
            a = hex[0]! + hex[0]!;
            rgb = hex.slice(1).replace(/./g, (c) => c + c);
            break;
        case 6:
            rgb = hex;
            break;
        case 8:
            a = hex.slice(0, 2);
            rgb = hex.slice(2);
            break;
        default:
            throw new Error(`Unsupported Android color: ${value}`);
    }
    return { rgb: `#${rgb.toLowerCase()}`, opacity: parseInt(a, 16) / 255 };
}

function esc(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(attrs: Record<string, string>, key: string, fallback: number): number {
    const raw = attrs[`android:${key}`];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`android:${key}="${raw}" is not a number`);
    return n;
}

/** Values of `android:strokeLineCap` / `android:strokeLineJoin` (same keywords as SVG), default first. */
const LINE_CAPS = ['butt', 'round', 'square'] as const;
const LINE_JOINS = ['miter', 'round', 'bevel'] as const;

/** Reads an enumerated attribute (default: the first keyword); anything else is not copied into the SVG. */
function keyword(attrs: Record<string, string>, key: string, allowed: readonly string[]): string {
    const raw = attrs[`android:${key}`];
    if (raw === undefined) return allowed[0]!;
    if (!allowed.includes(raw)) throw new Error(`Unsupported android:${key}=${JSON.stringify(raw)}`);
    return raw;
}

/** Reads a `<vector>` size (`24dp`, any unit suffix ignored); must be a positive number. */
function dp(attrs: Record<string, string>, key: string, fallback: number): number {
    const raw = attrs[`android:${key}`];
    if (raw === undefined) return fallback;
    const n = parseFloat(raw);
    if (!(n > 0 && Number.isFinite(n))) throw new Error(`android:${key}="${raw}" is not a positive size`);
    return n;
}

const TILE_TO_SPREAD: Record<string, string> = { clamp: 'pad', repeated: 'repeat', mirror: 'reflect' };

/** Mutable state threaded through the serialization (unique ids, collected `<defs>`, color resolution). */
interface Ctx {
    defs: string[];
    nextId: number;
    /** Resolves a color attribute value: a literal, or a reference through `options.colors`. */
    color: (value: string) => SvgColor;
}

/**
 * Validates `options.colors` and returns the color resolver of the preview: a reference takes its
 * mapped color, or {@link UNRESOLVED_COLOR} (recorded in `unresolved`); anything else must be a literal.
 * Values are parsed here, so only `#rrggbb` and a number ever reach the SVG.
 */
function colorResolver(colors: Readonly<Record<string, string>>, unresolved: Set<string>): Ctx['color'] {
    if (typeof colors !== 'object' || colors === null) throw new TypeError('colors must be an object');
    const resolved = new Map<string, SvgColor>();
    for (const [key, value] of Object.entries(colors)) {
        if (!REFERENCE_RE.test(key))
            throw new TypeError(`Invalid colors key ${JSON.stringify(key)} (expected @color/name or ?attr/name)`);
        let color: SvgColor;
        try {
            color = parseAndroidColor(String(value));
        } catch {
            throw new TypeError(
                `Invalid colors[${JSON.stringify(key)}]: ${JSON.stringify(value)} (expected #RGB, #ARGB, #RRGGBB or #AARRGGBB)`,
            );
        }
        resolved.set(key, color);
    }
    const fallback = parseAndroidColor(UNRESOLVED_COLOR);
    return (value) => {
        const ref = value.trim();
        if (!REFERENCE_RE.test(ref)) return parseAndroidColor(value);
        const color = resolved.get(ref);
        if (color) return color;
        unresolved.add(ref);
        return fallback;
    };
}

/** Emits an SVG gradient for an Android `<gradient>` into the defs; returns its paint `url(#…)`. */
function gradientToSvg(g: XmlNode, ctx: Ctx): string {
    const a = g.attrs;
    const type = a['android:type'] ?? 'linear';
    const id = `g${ctx.nextId++}`;
    const stops: { offset: number; color: string }[] = [];
    const items = g.children.filter((c) => c.name === 'item');
    if (items.length > 0) {
        for (const item of items) {
            const color = item.attrs['android:color'];
            if (color === undefined) throw new Error('<item> without android:color');
            stops.push({ offset: num(item.attrs, 'offset', 0), color });
        }
    } else {
        const start = a['android:startColor'];
        const center = a['android:centerColor'];
        const end = a['android:endColor'];
        if (start) stops.push({ offset: 0, color: start });
        if (center) stops.push({ offset: 0.5, color: center });
        if (end) stops.push({ offset: 1, color: end });
    }
    const stopXml = stops
        .map((s) => {
            const c = ctx.color(s.color);
            return `<stop offset="${s.offset}" stop-color="${c.rgb}" stop-opacity="${c.opacity}"/>`;
        })
        .join('');
    const spread = TILE_TO_SPREAD[a['android:tileMode'] ?? 'clamp'];
    if (!spread) throw new Error(`Unsupported android:tileMode="${a['android:tileMode']}"`);
    const common = `id="${id}" gradientUnits="userSpaceOnUse" spreadMethod="${spread}"`;
    if (type === 'linear') {
        const coords = `x1="${num(a, 'startX', 0)}" y1="${num(a, 'startY', 0)}" x2="${num(a, 'endX', 0)}" y2="${num(a, 'endY', 0)}"`;
        ctx.defs.push(`<linearGradient ${common} ${coords}>${stopXml}</linearGradient>`);
    } else if (type === 'radial') {
        const coords = `cx="${num(a, 'centerX', 0)}" cy="${num(a, 'centerY', 0)}" r="${num(a, 'gradientRadius', 0)}"`;
        ctx.defs.push(`<radialGradient ${common} ${coords}>${stopXml}</radialGradient>`);
    } else {
        throw new Error(`Gradient android:type="${type}" has no SVG equivalent`);
    }
    return `url(#${id})`;
}

/** Resolves a path paint (`fillColor` / `strokeColor`), from the attribute or an `<aapt:attr>` child. */
function paintOf(path: XmlNode, key: 'fillColor' | 'strokeColor', ctx: Ctx): SvgColor | null {
    const aapt = path.children.find((c) => c.name === 'aapt:attr' && c.attrs.name === `android:${key}`);
    if (aapt) {
        const gradient = aapt.children.find((c) => c.name === 'gradient');
        if (!gradient) throw new Error(`<aapt:attr name="android:${key}"> without <gradient>`);
        return { rgb: gradientToSvg(gradient, ctx), opacity: 1 };
    }
    const value = path.attrs[`android:${key}`];
    return value === undefined ? null : ctx.color(value);
}

/**
 * Visible part of a trimmed path, as fractions of the length of its *first contour*, or `null` when
 * the path is not trimmed. Mirrors Android (hwui `VectorDrawable.cpp` `applyTrim`, AndroidX
 * `VectorDrawableCompat`): no trim unless start ≠ 0 or end ≠ 1 (an offset alone does nothing);
 * start = end draws nothing; otherwise s = (start + offset) mod 1, e = (end + offset) mod 1 (sign
 * kept, as C `fmod`), clamped to [0, 1]; s > e wraps: [s, 1] then [0, e]. `PathMeasure` measures only
 * the first contour, so the trimmed path never contains the other contours.
 *
 * Android 16 QPR2 draws only [0, e] of a wrapping window: its Skia `getSegment(SkPath*)` replaces the
 * path instead of appending to it, so the second call of `applyTrim` drops [s, 1] (layoutlib 16.2.3
 * too). The preview keeps the documented behaviour, that of every earlier release (T-190, reported as
 * https://issuetracker.google.com/issues/585623232).
 */
function trimWindow(a: Record<string, string>): [number, number][] | null {
    const start = num(a, 'trimPathStart', 0);
    const end = num(a, 'trimPathEnd', 1);
    if (start === 0 && end === 1) return null;
    if (start === end) return [];
    const offset = num(a, 'trimPathOffset', 0);
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    const s = clamp((start + offset) % 1);
    const e = clamp((end + offset) % 1);
    if (s > e)
        return e > 0
            ? [
                  [s, 1],
                  [0, e],
              ]
            : [[s, 1]];
    return s < e ? [[s, e]] : [];
}

/**
 * The first contour of `d` (what Android trims): up to the next moveto once something was drawn, or
 * up to a drawing command that follows a closepath (Skia starts a new contour there too).
 */
function firstContour(d: string): string {
    const commands = /[MmZzLlHhVvCcSsQqTtAa]/g;
    let drawn = false;
    let closed = false;
    for (let m = commands.exec(d); m; m = commands.exec(d)) {
        const c = m[0];
        if (c === 'M' || c === 'm') {
            if (drawn) return d.slice(0, m.index).trimEnd();
            // Coordinates after the first pair are implicit linetos.
            const args = d.slice(m.index + 1).split(/[MmZzLlHhVvCcSsQqTtAa]/)[0]!;
            if ((args.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).length > 2) drawn = true;
            closed = false;
        } else if (c === 'Z' || c === 'z') {
            closed = true;
        } else {
            if (closed) return d.slice(0, m.index).trimEnd();
            drawn = true;
        }
    }
    return d;
}

/** Steps used to measure a curve or an arc by flattening it (relative error about 1e-5). */
const MEASURE_STEPS = 256;

/**
 * Length of SVG / VectorDrawable path data (all commands, relative or absolute; `Z` counts its closing
 * line, as Skia's `PathMeasure` does). Curves and arcs are flattened; a malformed tail stops the
 * measure where it is, like a renderer stops drawing there.
 */
function pathLength(d: string): number {
    let i = 0;
    const skip = () => {
        while (i < d.length && /[\s,]/.test(d[i]!)) i++;
    };
    const number = (): number | null => {
        skip();
        const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
        if (!m) return null;
        i += m[0].length;
        return Number(m[0]);
    };
    // Arc flags may be written without separators (`a1,1 0 011,1`).
    const flag = (): number | null => {
        skip();
        const c = d[i];
        if (c !== '0' && c !== '1') return null;
        i++;
        return Number(c);
    };
    let length = 0;
    let [x, y, sx, sy] = [0, 0, 0, 0];
    // Last control point of a C/S (cubic) or Q/T (quadratic) command, for the smooth reflections.
    let cubic: [number, number] | null = null;
    let quad: [number, number] | null = null;
    const curve = (point: (t: number) => [number, number]) => {
        let [px, py] = [x, y];
        for (let k = 1; k <= MEASURE_STEPS; k++) {
            const [qx, qy] = point(k / MEASURE_STEPS);
            length += Math.hypot(qx - px, qy - py);
            [px, py] = [qx, qy];
        }
    };
    const lineTo = (nx: number, ny: number) => {
        length += Math.hypot(nx - x, ny - y);
        [x, y] = [nx, ny];
    };
    let command = '';
    for (;;) {
        skip();
        if (i >= d.length) break;
        if (/[a-zA-Z]/.test(d[i]!)) command = d[i++]!;
        else if (!command || command === 'Z' || command === 'z') break;
        const rel = command === command.toLowerCase();
        const [ox, oy] = rel ? [x, y] : [0, 0];
        const C = command.toUpperCase();
        if (C === 'Z') {
            lineTo(sx, sy);
            cubic = quad = null;
            continue;
        }
        const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[C];
        if (arity === undefined) break;
        const n: number[] = [];
        for (let k = 0; k < arity; k++) {
            const v = C === 'A' && (k === 3 || k === 4) ? flag() : number();
            if (v === null) return length;
            n.push(v);
        }
        const nc: [number, number] | null = cubic;
        const nq: [number, number] | null = quad;
        cubic = quad = null;
        if (C === 'M') {
            [x, y] = [ox + n[0]!, oy + n[1]!];
            [sx, sy] = [x, y];
            // Coordinate pairs after a moveto are implicit linetos.
            command = rel ? 'l' : 'L';
        } else if (C === 'L') lineTo(ox + n[0]!, oy + n[1]!);
        else if (C === 'H') lineTo(ox + n[0]!, y);
        else if (C === 'V') lineTo(x, oy + n[0]!);
        else if (C === 'C' || C === 'S') {
            const [x1, y1]: [number, number] =
                C === 'C' ? [ox + n[0]!, oy + n[1]!] : nc ? [2 * x - nc[0], 2 * y - nc[1]] : [x, y];
            const k = C === 'C' ? 2 : 0;
            const [x2, y2, ex, ey] = [ox + n[k]!, oy + n[k + 1]!, ox + n[k + 2]!, oy + n[k + 3]!];
            const [x0, y0] = [x, y];
            curve((t) => {
                const u = 1 - t;
                const [a, b, c, e] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
                return [a * x0 + b * x1 + c * x2 + e * ex, a * y0 + b * y1 + c * y2 + e * ey];
            });
            [x, y, cubic] = [ex, ey, [x2, y2]];
        } else if (C === 'Q' || C === 'T') {
            const [x1, y1]: [number, number] =
                C === 'Q' ? [ox + n[0]!, oy + n[1]!] : nq ? [2 * x - nq[0], 2 * y - nq[1]] : [x, y];
            const k = C === 'Q' ? 2 : 0;
            const [ex, ey] = [ox + n[k]!, oy + n[k + 1]!];
            const [x0, y0] = [x, y];
            curve((t) => {
                const u = 1 - t;
                return [u * u * x0 + 2 * u * t * x1 + t * t * ex, u * u * y0 + 2 * u * t * y1 + t * t * ey];
            });
            [x, y, quad] = [ex, ey, [x1, y1]];
        } else {
            arcLength(n, ox, oy);
        }
    }
    return length;

    /** Endpoint → center parameterization (SVG 1.1 implementation notes, F.6.5 / F.6.6), then flattened. */
    function arcLength([rx0, ry0, angle, large, sweep, ex0, ey0]: number[], ox: number, oy: number): void {
        const [ex, ey] = [ox + ex0!, oy + ey0!];
        let [rx, ry] = [Math.abs(rx0!), Math.abs(ry0!)];
        if (rx === 0 || ry === 0 || (ex === x && ey === y)) return lineTo(ex, ey);
        const phi = (angle! * Math.PI) / 180;
        const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
        const [dx, dy] = [(x - ex) / 2, (y - ey) / 2];
        const x1 = cos * dx + sin * dy;
        const y1 = -sin * dx + cos * dy;
        const scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
        if (scale > 1) [rx, ry] = [rx * Math.sqrt(scale), ry * Math.sqrt(scale)];
        const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
        const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
        const [cx1, cy1] = [(coef * rx * y1) / ry, (-coef * ry * x1) / rx];
        const ang = (ux: number, uy: number, vx: number, vy: number) =>
            Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        const theta = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
        let delta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
        if (!sweep && delta > 0) delta -= 2 * Math.PI;
        if (sweep && delta < 0) delta += 2 * Math.PI;
        const [cx, cy] = [cos * cx1 - sin * cy1 + (x + ex) / 2, sin * cx1 + cos * cy1 + (y + ey) / 2];
        curve((t) => {
            const a = theta + delta * t;
            const [px, py] = [rx * Math.cos(a), ry * Math.sin(a)];
            return [cx + cos * px - sin * py, cy + sin * px + cos * py];
        });
        [x, y] = [ex, ey];
    }
}

/** A dash length for an SVG attribute, without float noise. */
const len = (x: number) => String(Number(x.toFixed(4)));

/**
 * `stroke-dasharray` / `stroke-dashoffset` drawing exactly `window` (fractions) of a contour of
 * `total` user units. Absolute lengths rather than `pathLength="1"`, which resvg ignores. Each gap is
 * at least `total`, so the pattern never repeats along the contour. Known difference: when the
 * window wraps across the start of a *closed* contour, SVG renderers join the two dashes there,
 * where Android draws two separate segments (butt / round / square ends instead of a join).
 */
function trimDashes(window: [number, number][], total: number): string[] {
    if (window.length === 2) {
        const [[s], [, e]] = window as [[number, number], [number, number]];
        return [`stroke-dasharray="${[e, s - e, 1 - s, 1].map((f) => len(f * total)).join(' ')}"`];
    }
    const [[s, e]] = window as [[number, number]];
    const out = [`stroke-dasharray="${len((e - s) * total)} ${len(total)}"`];
    if (s > 0) out.push(`stroke-dashoffset="${len(-s * total)}"`);
    return out;
}

/** Whether a path has a fill (attribute or `<aapt:attr>` gradient), without resolving it. */
function hasFill(path: XmlNode): boolean {
    return (
        path.attrs['android:fillColor'] !== undefined ||
        path.children.some((c) => c.name === 'aapt:attr' && c.attrs.name === 'android:fillColor')
    );
}

/**
 * Whether the drawable has a trimmed *filled* path, which {@link vectorDrawableToSvg} draws whole
 * (Android fills the trimmed geometry: not expressible with SVG dashes).
 */
export function hasUnrenderedTrim(xml: string): boolean {
    const visit = (node: XmlNode): boolean =>
        (node.name === 'path' && hasFill(node) && trimWindow(node.attrs) !== null) || node.children.some(visit);
    return visit(parseXml(xml));
}

function pathToSvg(path: XmlNode, ctx: Ctx): string {
    const a = path.attrs;
    let d = a['android:pathData'];
    if (!d) return '';
    // A stroke-only trimmed path: the first contour, dashed to the visible window.
    let window = hasFill(path) ? null : trimWindow(a);
    let total = 0;
    if (window) {
        d = firstContour(d);
        total = pathLength(d);
        // A zero-length contour has nothing to trim: Skia's getSegment draws nothing.
        if (!(total > 0)) window = [];
    }
    const out = [`d="${esc(d)}"`];
    const fill = paintOf(path, 'fillColor', ctx);
    if (fill) {
        out.push(`fill="${fill.rgb}"`);
        const opacity = fill.opacity * num(a, 'fillAlpha', 1);
        if (opacity !== 1) out.push(`fill-opacity="${opacity}"`);
        if (a['android:fillType'] === 'evenOdd') out.push('fill-rule="evenodd"');
    } else {
        out.push('fill="none"');
    }
    const stroke = paintOf(path, 'strokeColor', ctx);
    const strokeWidth = num(a, 'strokeWidth', 0);
    // An empty trim window draws nothing: no stroke at all (the path is not filled).
    if (stroke && strokeWidth > 0 && window?.length !== 0) {
        out.push(`stroke="${stroke.rgb}"`, `stroke-width="${strokeWidth}"`);
        const opacity = stroke.opacity * num(a, 'strokeAlpha', 1);
        if (opacity !== 1) out.push(`stroke-opacity="${opacity}"`);
        out.push(`stroke-linecap="${keyword(a, 'strokeLineCap', LINE_CAPS)}"`);
        out.push(`stroke-linejoin="${keyword(a, 'strokeLineJoin', LINE_JOINS)}"`);
        out.push(`stroke-miterlimit="${num(a, 'strokeMiterLimit', 4)}"`);
        if (window) out.push(...trimDashes(window, total));
    }
    return `<path ${out.join(' ')}/>`;
}

/** Android group matrix (scale → rotate → translate around the pivot) as an SVG transform list. */
function groupTransform(a: Record<string, string>): string {
    const px = num(a, 'pivotX', 0);
    const py = num(a, 'pivotY', 0);
    const tx = num(a, 'translateX', 0);
    const ty = num(a, 'translateY', 0);
    const rot = num(a, 'rotation', 0);
    const sx = num(a, 'scaleX', 1);
    const sy = num(a, 'scaleY', 1);
    const parts: string[] = [];
    if (tx + px !== 0 || ty + py !== 0) parts.push(`translate(${tx + px} ${ty + py})`);
    if (rot !== 0) parts.push(`rotate(${rot})`);
    if (sx !== 1 || sy !== 1) parts.push(`scale(${sx} ${sy})`);
    if (px !== 0 || py !== 0) parts.push(`translate(${-px} ${-py})`);
    return parts.join(' ');
}

/** Serializes a group's children; each `<clip-path>` wraps all the siblings that follow it. */
function childrenToSvg(children: XmlNode[], ctx: Ctx): string {
    let out = '';
    for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (child.name === 'clip-path') {
            const id = `c${ctx.nextId++}`;
            const d = child.attrs['android:pathData'] ?? '';
            ctx.defs.push(`<clipPath id="${id}"><path d="${esc(d)}"/></clipPath>`);
            // The clip lives in the group's coordinate space, as does this wrapper <g>.
            return `${out}<g clip-path="url(#${id})">${childrenToSvg(children.slice(i + 1), ctx)}</g>`;
        }
        if (child.name === 'path') out += pathToSvg(child, ctx);
        else if (child.name === 'group') {
            const t = groupTransform(child.attrs);
            out += `<g${t ? ` transform="${t}"` : ''}>${childrenToSvg(child.children, ctx)}</g>`;
        } else throw new Error(`Unsupported VectorDrawable element <${child.name}>`);
    }
    return out;
}

/**
 * `android:tintMode` → SVG `feComposite` attributes, with the tint flood as `in` and the drawing as
 * `in2`. Filters run on premultiplied colors, so `arithmetic` (k1·i1·i2 + k2·i1 + k3·i2) is exactly
 * the PorterDuff formula of each mode.
 */
const TINT_COMPOSITE: Record<string, string> = {
    src_in: 'operator="in"',
    src_atop: 'operator="atop"',
    src_over: 'operator="over"',
    multiply: 'operator="arithmetic" k1="1" k2="0" k3="0" k4="0"',
    screen: 'operator="arithmetic" k1="-1" k2="1" k3="1" k4="0"',
    add: 'operator="arithmetic" k1="0" k2="1" k3="1" k4="0"',
};

/** Wraps the drawing in a filter applying `android:tint` (literal or resolved reference) with its `android:tintMode`. */
function applyTint(body: string, a: Record<string, string>, vw: number, vh: number, ctx: Ctx): string {
    const tint = a['android:tint'];
    if (tint === undefined) return body;
    const mode = a['android:tintMode'] ?? 'src_in';
    const composite = TINT_COMPOSITE[mode];
    if (!composite) throw new Error(`Unsupported android:tintMode="${mode}"`);
    const c = ctx.color(tint);
    const id = `t${ctx.nextId++}`;
    // The region is the whole viewport (src_over / add tint transparent pixels too, as on Android).
    ctx.defs.push(
        `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${vw}" height="${vh}" ` +
            `color-interpolation-filters="sRGB"><feFlood flood-color="${c.rgb}" flood-opacity="${c.opacity}"/>` +
            `<feComposite in2="SourceGraphic" ${composite}/></filter>`,
    );
    return `<g filter="url(#${id})">${body}</g>`;
}

/**
 * Converts a VectorDrawable XML string into an equivalent standalone SVG string (preview).
 *
 * The SVG `width` / `height` are the vector's `android:width` / `android:height` in dp times
 * `options.density` (default 1), its `viewBox` the viewport, stretched with `preserveAspectRatio="none"`
 * like Android. See the module documentation for the reproduced semantics and the unsupported input,
 * which throws an `Error` (e.g. a sweep gradient). Color references take `options.colors`, or gray.
 *
 * ```ts
 * import { convert, vectorDrawableToSvg } from 'svg-vectordrawable';
 * const preview = vectorDrawableToSvg(convert(svg).xml, { density: 4 });
 * const themed = vectorDrawableToSvg(convert(svg, { currentColor: '?attr/colorPrimary' }).xml, {
 *     colors: { '?attr/colorPrimary': '#6750A4' },
 *     onUnresolvedColor: (ref) => console.warn(`no preview color for ${ref}`),
 * });
 * ```
 */
export function vectorDrawableToSvg(xml: string, options: PreviewOptions = {}): string {
    const density = options.density ?? 1;
    if (!(density > 0 && Number.isFinite(density))) throw new Error(`density must be a positive number (${density})`);
    const unresolved = new Set<string>();
    const color = colorResolver(options.colors ?? {}, unresolved);
    const vector = parseXml(xml);
    if (vector.name !== 'vector') throw new Error(`Root element is <${vector.name}>, expected <vector>`);
    const a = vector.attrs;
    const vw = num(a, 'viewportWidth', NaN);
    const vh = num(a, 'viewportHeight', NaN);
    if (!(vw > 0 && vh > 0)) throw new Error('<vector> needs positive viewportWidth / viewportHeight');
    // `24dp` → 24: dp map 1:1 to SVG user units at mdpi (density 1).
    const w = dp(a, 'width', vw) * density;
    const h = dp(a, 'height', vh) * density;
    const ctx: Ctx = { defs: [], nextId: 0, color };
    let body = childrenToSvg(vector.children, ctx);
    if (options.applyTint) body = applyTint(body, a, vw, vh, ctx);
    const alpha = num(a, 'alpha', 1);
    if (alpha !== 1) body = `<g opacity="${alpha}">${body}</g>`;
    const defs = ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : '';
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${vw} ${vh}" ` +
        `preserveAspectRatio="none">${defs}${body}</svg>`;
    if (options.onUnresolvedColor) for (const ref of unresolved) options.onUnresolvedColor(ref);
    return svg;
}
