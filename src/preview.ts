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
 *
 * Unsupported input throws an `Error` naming the construct: sweep gradients (no SVG equivalent),
 * resource / theme references instead of color literals (`@color/…`, `?attr/…`), unknown elements,
 * malformed XML, a missing or non-positive viewport. `trimPathStart` / `trimPathEnd` /
 * `trimPathOffset` (never produced by the converter) are ignored.
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
     * Apply the vector's `android:tint` (color literal only) with its `android:tintMode` (default
     * `src_in`; `src_over`, `src_atop`, `multiply`, `screen`, `add` supported) as an SVG filter.
     * Default `false`: the tint is ignored and the drawing keeps its own colors.
     */
    applyTint?: boolean;
}

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

const TILE_TO_SPREAD: Record<string, string> = { clamp: 'pad', repeated: 'repeat', mirror: 'reflect' };

/** Mutable state threaded through the serialization (unique ids, collected `<defs>`). */
interface Ctx {
    defs: string[];
    nextId: number;
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
            const c = parseAndroidColor(s.color);
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
    return value === undefined ? null : parseAndroidColor(value);
}

function pathToSvg(path: XmlNode, ctx: Ctx): string {
    const a = path.attrs;
    const d = a['android:pathData'];
    if (!d) return '';
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
    if (stroke && strokeWidth > 0) {
        out.push(`stroke="${stroke.rgb}"`, `stroke-width="${strokeWidth}"`);
        const opacity = stroke.opacity * num(a, 'strokeAlpha', 1);
        if (opacity !== 1) out.push(`stroke-opacity="${opacity}"`);
        out.push(`stroke-linecap="${a['android:strokeLineCap'] ?? 'butt'}"`);
        out.push(`stroke-linejoin="${a['android:strokeLineJoin'] ?? 'miter'}"`);
        out.push(`stroke-miterlimit="${num(a, 'strokeMiterLimit', 4)}"`);
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

/** Wraps the drawing in a filter applying `android:tint` (literal color) with its `android:tintMode`. */
function applyTint(body: string, a: Record<string, string>, vw: number, vh: number, ctx: Ctx): string {
    const tint = a['android:tint'];
    if (tint === undefined) return body;
    const mode = a['android:tintMode'] ?? 'src_in';
    const composite = TINT_COMPOSITE[mode];
    if (!composite) throw new Error(`Unsupported android:tintMode="${mode}"`);
    const c = parseAndroidColor(tint);
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
 * which throws an `Error` (e.g. a sweep gradient or a `@color/…` reference).
 *
 * ```ts
 * import { convert, vectorDrawableToSvg } from 'svg-vectordrawable';
 * const preview = vectorDrawableToSvg(convert(svg).xml, { density: 4 });
 * ```
 */
export function vectorDrawableToSvg(xml: string, options: PreviewOptions = {}): string {
    const density = options.density ?? 1;
    if (!(density > 0 && Number.isFinite(density))) throw new Error(`density must be a positive number (${density})`);
    const vector = parseXml(xml);
    if (vector.name !== 'vector') throw new Error(`Root element is <${vector.name}>, expected <vector>`);
    const a = vector.attrs;
    const vw = num(a, 'viewportWidth', NaN);
    const vh = num(a, 'viewportHeight', NaN);
    if (!(vw > 0 && vh > 0)) throw new Error('<vector> needs positive viewportWidth / viewportHeight');
    // `24dp` → 24: dp map 1:1 to SVG user units at mdpi (density 1).
    const w = parseFloat(a['android:width'] ?? `${vw}`) * density;
    const h = parseFloat(a['android:height'] ?? `${vh}`) * density;
    const ctx: Ctx = { defs: [], nextId: 0 };
    let body = childrenToSvg(vector.children, ctx);
    if (options.applyTint) body = applyTint(body, a, vw, vh, ctx);
    const alpha = num(a, 'alpha', 1);
    if (alpha !== 1) body = `<g opacity="${alpha}">${body}</g>`;
    const defs = ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : '';
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${vw} ${vh}" ` +
        `preserveAspectRatio="none">${defs}${body}</svg>`
    );
}
