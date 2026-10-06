import { toAndroidColor } from './color.js';
import type { ConvertContext } from './context.js';
import { dashPathData, ellipseDashPath, parseDasharray } from './dash.js';
import { escapeXml, formatNumber } from './format.js';
import {
    renderGradient,
    resolveEllipticalRadial,
    resolveGradient,
    warnFocal,
    type EllipticalRadial,
    type RawGradient,
    type ResolvedGradient,
    type XastElement,
} from './gradient.js';
import { fillOf, strokeWidthOf, type Inherited } from './inherited.js';
import { normalizeArcFlags, pathBBox, transformPathData } from './pathData.js';
import { isNone, presentation } from './style.js';
import { multiply, scaleFactor, type Matrix } from './transform.js';
import { parseLength } from './units.js';
import { diagonal } from './viewport.js';

/** An SVG paint: `url(#id)` with an optional fallback color, or a plain color / `none`. */
interface Paint {
    ref?: string;
    color?: string;
}

function parsePaint(raw: string): Paint {
    const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(raw.trim());
    if (!m) return { color: raw.trim() };
    const fallback = m[2]!.trim();
    return fallback ? { ref: m[1]!, color: fallback } : { ref: m[1]! };
}

/** True when a `paint-order` value paints the stroke below the fill (the reverse of VectorDrawable's order). */
function strokeBeforeFill(value: string): boolean {
    const listed = value.trim().toLowerCase().split(/\s+/);
    if (listed[0] === 'normal') return false;
    // Unlisted keywords follow the listed ones in their default order (fill, stroke, markers).
    const order = [...listed, 'fill', 'stroke', 'markers'];
    return order.indexOf('stroke') < order.indexOf('fill');
}

/** A `<path>` being rendered: its attributes and `aapt:attr` gradient children. */
class PathBuilder {
    private readonly attrs: [string, string][] = [];
    private readonly gradients: { gradient: ResolvedGradient; attr: 'fillColor' | 'strokeColor' }[] = [];
    private skewWarned = false;
    /** An elliptical radial fill that can be exact, until {@link settleFill} decides. */
    private pendingFill: { raw: RawGradient; exact: EllipticalRadial } | null = null;
    /** Transform attributes of the `<group>` wrapping the path (exact elliptical radial fill). */
    private groupAttrs: [string, string][] | null = null;

    constructor(
        private readonly ctx: ConvertContext,
        /** Final pathData (baked and normalized). */
        private pathData: string,
        private readonly style: Inherited,
        private readonly pad: string,
        private readonly bake: Matrix | undefined,
        /** Geometry whose bounding box `objectBoundingBox` gradients use (the undashed path). */
        private readonly bboxData = pathData,
        /** The element's own geometry (before `bake`): lets an elliptical radial fill be exact. */
        private readonly source?: string,
    ) {}

    attr(name: string, value: string): void {
        this.attrs.push([name, value]);
    }

    /**
     * Resolves a fill or stroke gradient into an aapt:attr child. Per SVG, objectBoundingBox uses
     * the geometry bounding box for strokes too (never the stroke extent). An elliptical radial
     * fill is held back for {@link settleFill}.
     */
    gradient(g: RawGradient, attr: 'fillColor' | 'strokeColor'): void {
        if (attr === 'fillColor' && this.source !== undefined) {
            // objectBoundingBox is measured in the element's user space, before any baked transform.
            const bbox = g.objectBox ? pathBBox(this.source) : null;
            const exact = resolveEllipticalRadial(g, bbox, this.style.viewport, this.ctx.precision, this.bake);
            if (exact) {
                this.pendingFill = { raw: g, exact };
                return;
            }
        }
        this.resolve(g, attr);
    }

    private resolve(g: RawGradient, attr: 'fillColor' | 'strokeColor'): void {
        const { ctx } = this;
        if (this.bake && !this.skewWarned) {
            this.skewWarned = true;
            ctx.warn({
                code: 'gradient-under-skew',
                message: 'Gradient under a skewed/baked group may be imprecisely placed.',
                node: 'path',
            });
        }
        const bbox = g.objectBox ? pathBBox(this.bboxData) : null;
        const resolved = resolveGradient(g, bbox, this.style.viewport, ctx.precision, ctx.warn);
        this.gradients.push({ gradient: resolved, attr });
        ctx.usesGradient = true;
    }

    /**
     * Settles a held-back elliptical radial fill. When `exact` (no stroke drawn by this path: the
     * group would distort it), the path is drawn in a `<group>` carrying the gradient's shape, with
     * its geometry mapped back and a circular gradient (see {@link resolveEllipticalRadial});
     * otherwise the fill keeps the circle-of-equal-area approximation. Call before any stroke paint.
     */
    settleFill(exact: boolean): void {
        const pending = this.pendingFill;
        if (!pending) return;
        this.pendingFill = null;
        if (!exact) {
            this.resolve(pending.raw, 'fillColor');
            return;
        }
        const { ctx } = this;
        const { rotation, scaleY, toLocal, gradient, focal } = pending.exact;
        if (focal) warnFocal(ctx.warn);
        this.pathData = transformPathData(this.source!, this.bake ? multiply(toLocal, this.bake) : toLocal);
        this.gradients.push({ gradient, attr: 'fillColor' });
        ctx.usesGradient = true;
        this.groupAttrs = [];
        if (rotation !== 0) this.groupAttrs.push(['rotation', formatNumber(rotation, ctx.precision)]);
        this.groupAttrs.push(['scaleY', formatNumber(scaleY, ctx.precision)]);
    }

    /** True when the path uses a gradient (an `aapt:attr` child). */
    get hasGradient(): boolean {
        return this.gradients.length > 0;
    }

    /**
     * True when the path paints something: a fill or a stroke whose paint is a gradient or a
     * non-transparent color, with a non-zero alpha (and, for the stroke, a non-zero width).
     */
    paints(): boolean {
        const value = (name: string): string | undefined => this.attrs.find(([n]) => n === name)?.[1];
        const painted = (attr: 'fillColor' | 'strokeColor', alpha: string): boolean => {
            const color = value(attr);
            const paint = this.gradients.some((g) => g.attr === attr) || (color !== undefined && !/^#00/.test(color));
            return paint && parseFloat(value(alpha) ?? '1') > 0;
        };
        // Width 0 is exactly what SVG draws as nothing (Android would draw a hairline).
        const stroked = painted('strokeColor', 'strokeAlpha') && parseFloat(value('strokeWidth') ?? '1') !== 0;
        return painted('fillColor', 'fillAlpha') || stroked;
    }

    toString(): string {
        const { step } = this.ctx;
        const pad = this.groupAttrs ? this.pad + step : this.pad;
        const lines = [
            `${pad}<path`,
            `${pad}${step}android:pathData="${escapeXml(this.pathData)}"`,
            ...this.attrs.map(([name, value]) => `${pad}${step}android:${name}="${value}"`),
        ];
        const children = this.gradients.map((g) => renderGradient(g.gradient, pad, step, g.attr));
        const path = children.length
            ? `${lines.join('\n')}>\n${children.join('\n')}\n${pad}</path>`
            : `${lines.join('\n')} />`;
        if (!this.groupAttrs) return path;
        const head = [
            `${this.pad}<group`,
            ...this.groupAttrs.map(([name, value]) => `${this.pad}${step}android:${name}="${value}"`),
        ];
        return `${head.join('\n')}>\n${path}\n${this.pad}</group>`;
    }
}

/** Emits the fill attributes; true when the fill is painted. */
function emitFill(ctx: ConvertContext, path: PathBuilder, style: Inherited): boolean {
    const fill = parsePaint(fillOf(style, ctx.fillBlackForUnfilled));
    const raw = fill.ref !== undefined ? ctx.gradients.get(fill.ref) : undefined;
    let fillColor = fill.color;
    if (raw) {
        path.gradient(raw, 'fillColor');
        fillColor = undefined;
    } else if (fill.ref !== undefined && ctx.patternIds.has(fill.ref)) {
        ctx.warn({
            code: 'unsupported-paint',
            message: `<pattern> fill "${fill.ref}" cannot be represented in a VectorDrawable; using ${fillColor ? 'its fallback color' : 'black'}.`,
            node: 'path',
        });
        fillColor ??= '#000000';
    } else if (fill.ref !== undefined && fillColor === undefined) {
        ctx.warn({
            code: 'missing-gradient',
            message: `Path references unknown gradient "${fill.ref}"; using black.`,
            node: 'path',
        });
        fillColor = '#000000';
    }
    // A missing reference with a fallback color is valid SVG: the fallback is the rendering.
    if (fillColor !== undefined && !isNone(fillColor)) {
        const color = toAndroidColor(fillColor, undefined, style.color);
        if (color) path.attr('fillColor', color);
    }

    const fillAlpha = style.fillOpacity * style.opacityMul;
    if (fillAlpha < 1) path.attr('fillAlpha', String(Math.max(fillAlpha, 0)));
    if (style.fillRule === 'evenodd') path.attr('fillType', 'evenOdd');
    return raw !== undefined || (fillColor !== undefined && !isNone(fillColor));
}

/** A painted stroke: a resolvable gradient or an Android color. */
type StrokePaint = { gradient: RawGradient } | { color: string };

/** Resolves the stroke paint (reporting unusable references); null when no stroke is painted. */
function resolveStroke(ctx: ConvertContext, style: Inherited): StrokePaint | null {
    const stroke = parsePaint(style.stroke ?? 'none');
    // A resolvable gradient wins over the fallback color (SVG uses the fallback only for a bad reference).
    const strokeGradient = stroke.ref !== undefined ? ctx.gradients.get(stroke.ref) : undefined;
    const strokeColor = strokeGradient ? undefined : stroke.color;
    if (stroke.ref !== undefined && !strokeGradient) {
        if (ctx.patternIds.has(stroke.ref))
            ctx.warn({
                code: 'unsupported-paint',
                message: `Pattern strokes are not supported by VectorDrawable; ${strokeColor ? 'using the fallback color' : 'stroke dropped'}.`,
                node: 'path',
            });
        else if (strokeColor === undefined)
            ctx.warn({
                code: 'missing-gradient',
                message: `Stroke references unknown paint "${stroke.ref}"; stroke dropped.`,
                node: 'path',
            });
    }
    if (strokeGradient) return { gradient: strokeGradient };
    const solidStroke =
        strokeColor !== undefined && !isNone(strokeColor) ? toAndroidColor(strokeColor, undefined, style.color) : null;
    return solidStroke ? { color: solidStroke } : null;
}

/**
 * The dashed geometry of a painted stroke (pathData in the same space as the emitted path),
 * undefined for a solid stroke, `''` when no dash is visible (the stroke draws nothing). Dashes are cut in the element's user space, before any baked
 * transform, as SVG measures them. Reports `unsupported-stroke-dasharray` when dashing fails.
 */
function dashedPathData(
    ctx: ConvertContext,
    d: string,
    el: XastElement,
    style: Inherited,
    bake: Matrix | undefined,
): string | undefined {
    const diag = diagonal(style.viewport);
    const pattern = parseDasharray(style.strokeDasharray, diag);
    if (pattern?.length === 0) return undefined; // solid
    const rawOffset = style.strokeDashoffset?.trim();
    const offset = rawOffset === undefined ? 0 : parseLength(rawOffset, diag);
    const rawLength = el.attributes?.pathLength;
    const pathLength = rawLength === undefined ? undefined : parseFloat(rawLength);
    const shape = el.name === 'circle' || el.name === 'ellipse' ? ellipseDashPath(d) : d;
    const dashed =
        pattern && !Number.isNaN(offset)
            ? dashPathData(shape, pattern, offset, diag * DASH_TOLERANCE, {
                  // A baked path is re-rounded by transformPathData: keep full precision until then.
                  precision: bake ? 6 : ctx.precision,
                  ...(pathLength !== undefined && pathLength > 0 ? { pathLength } : {}),
              })
            : null;
    if (dashed === null) {
        ctx.warn({
            code: 'unsupported-stroke-dasharray',
            message: `stroke-dasharray="${style.strokeDasharray!.trim()}" could not be converted to dash geometry; the stroke is drawn solid.`,
            node: 'path',
        });
        return undefined;
    }
    return bake ? transformPathData(dashed, bake) : dashed;
}

/** Arc-length tolerance of dash cuts on curves, relative to the viewport diagonal (24 → 2.4e-4). */
const DASH_TOLERANCE = 1e-5;

/** Emits the attributes of a painted stroke. */
function emitStroke(
    ctx: ConvertContext,
    path: PathBuilder,
    style: Inherited,
    paint: StrokePaint,
    bake: Matrix | undefined,
): void {
    if ('gradient' in paint) path.gradient(paint.gradient, 'strokeColor');
    else path.attr('strokeColor', paint.color);
    // Baked geometry is scaled, the stroke must follow (approximated for non-uniform scale).
    const strokeScale = bake ? scaleFactor(bake) : 1;
    path.attr('strokeWidth', formatNumber(strokeWidthOf(style) * strokeScale, ctx.precision));
    const sa = style.strokeOpacity * style.opacityMul;
    if (sa < 1) path.attr('strokeAlpha', String(Math.max(sa, 0)));
    if (style.strokeLinecap === 'round' || style.strokeLinecap === 'square')
        path.attr('strokeLineCap', style.strokeLinecap);
    if (style.strokeLinejoin === 'round' || style.strokeLinejoin === 'bevel' || style.strokeLinejoin === 'miter')
        path.attr('strokeLineJoin', style.strokeLinejoin);
    else if (style.strokeLinejoin === 'arcs' || style.strokeLinejoin === 'miter-clip')
        ctx.warn({
            code: 'unsupported-attribute',
            message: `stroke-linejoin="${style.strokeLinejoin}" is not supported by VectorDrawable; miter is used.`,
            node: 'path',
        });
    if (style.strokeMiterlimit)
        path.attr('strokeMiterLimit', formatNumber(parseFloat(style.strokeMiterlimit), ctx.precision));
}

/** A number in pathData: sign, mantissa, optional exponent. */
const PATH_NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Decimal places a number literal carries (`1.25` → 2, `1e-7` → 7, `1.5e2` → -1). */
function decimalsOf(literal: string): number {
    const [mantissa, exponent] = literal.toLowerCase().split('e');
    const dot = mantissa!.indexOf('.');
    return (dot < 0 ? 0 : mantissa!.length - dot - 1) - (exponent ? parseInt(exponent, 10) : 0);
}

/**
 * Rounds the numbers of `d` that carry more than `precision` decimals, leaving everything else
 * (commands, separators, shorter numbers) byte-identical. A rounded number that lost its sign or
 * its dot is separated from a neighbour it would otherwise merge with (`1-0.00001` → `1 0`,
 * `1.00001.5` → `1 .5`). Arc flags must already be separated (see `normalizeArcFlags`).
 */
export function roundPathNumbers(d: string, precision: number): string {
    let out = '';
    let last = 0;
    for (const m of d.matchAll(PATH_NUMBER_RE)) {
        const literal = m[0];
        if (decimalsOf(literal) <= precision) continue;
        const start = m.index;
        const end = start + literal.length;
        let rounded = formatNumber(parseFloat(literal), precision);
        out += d.slice(last, start);
        if (/^\d/.test(rounded) && /[\d.]$/.test(out)) rounded = ` ${rounded}`;
        if (d[end] === '.' && !rounded.includes('.')) rounded += ' ';
        out += rounded;
        last = end;
    }
    return last === 0 ? d : out + d.slice(last);
}

/**
 * Renders a drawable element as a `<path>` with its fill and stroke (solid colors or gradients),
 * reporting what a VectorDrawable cannot express. `bake` is a transform already applied to `d`.
 * Clipping is left to the caller.
 */
export function renderPath(
    ctx: ConvertContext,
    d: string,
    el: XastElement,
    style: Inherited,
    pad: string,
    bake?: Matrix,
): string {
    const pathData = bake ? transformPathData(d, bake) : roundPathNumbers(normalizeArcFlags(d), ctx.precision);
    const usedGradient = ctx.usesGradient;
    const path = new PathBuilder(ctx, pathData, style, pad, bake, pathData, d);
    const fillPainted = emitFill(ctx, path, style);
    const stroke = resolveStroke(ctx, style);
    const dashed = stroke ? dashedPathData(ctx, d, el, style, bake) : undefined;
    const strokePainted = stroke !== null && dashed !== '';
    // A dashed stroke gets its own path: the fill keeps the original geometry.
    const strokePath = dashed ? new PathBuilder(ctx, dashed, style, pad, bake, pathData) : path;
    // An exact elliptical radial fill transforms its path's space: only without a stroke on that path.
    path.settleFill(strokePath !== path || !strokePainted);
    if (stroke && strokePainted) emitStroke(ctx, strokePath, style, stroke, bake);
    const paintOrder = style.paintOrder;
    const strokeFirst = fillPainted && strokePainted && !!paintOrder && strokeBeforeFill(paintOrder);
    // A path painting nothing (no fill nor stroke, transparent, zero alpha or width) is dropped.
    const paths = (strokePath === path ? [path] : fillPainted ? [path, strokePath] : [strokePath]).filter((p) =>
        p.paints(),
    );
    if (paths.length === 0) {
        // Lossless: no warning about how the path would have been drawn, nor an unused aapt namespace.
        ctx.usesGradient = usedGradient;
        return '';
    }
    if (!paths.some((p) => p.hasGradient)) ctx.usesGradient = usedGradient;
    // Separate fill and stroke paths honor paint-order by their order.
    if (paths.length === 2 && strokeFirst) paths.reverse();

    const vectorEffect = presentation(el, 'vector-effect')?.trim();
    if (vectorEffect && vectorEffect !== 'none')
        ctx.warn({
            code: 'unsupported-attribute',
            message: `vector-effect="${vectorEffect}" cannot be represented in a VectorDrawable; ignored.`,
            node: 'path',
        });
    if (strokeFirst && strokePath === path)
        ctx.warn({
            code: 'unsupported-attribute',
            message: `paint-order="${paintOrder!.trim()}" cannot be represented in a VectorDrawable; the stroke is drawn over the fill.`,
            node: 'path',
        });

    // `opacity` composites the element as one layer; splitting it into fillAlpha and
    // strokeAlpha lets the fill show through the inner half of the stroke.
    if (style.opacityMul < 1 && fillPainted && strokePainted)
        ctx.warn({
            code: 'opacity-approximated',
            message: 'opacity on a path with both fill and stroke is approximated by fillAlpha/strokeAlpha.',
            node: 'path',
        });
    return paths.join('\n');
}
