import type { XastElement } from './ast.js';
import { alphaAttr, type ResolvedColor } from './colorRef.js';
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
} from './gradient.js';
import { fillOf, strokeWidthOf, type Inherited } from './inherited.js';
import { normalizeArcFlags, pathBBox, transformPathData } from './pathData.js';
import { isNone, presentation } from './style.js';
import { multiply, scaleFactor, type Matrix } from './transform.js';
import type { AndroidColor } from './types.js';
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

/** SVG 2 paints taken from the referencing element (`<use>`, marker), which the converter does not track. */
const CONTEXT_PAINT = /^context-(?:fill|stroke)$/i;

/** SVG's initial fill (black), the one `fillBlackForUnfilled` emits. */
const INITIAL_FILL = '#FF000000' as AndroidColor;

/**
 * The Android color of a solid paint (literal or reference, through `ctx.colors`), null when nothing
 * is painted (no value, `none`). A value the color parser cannot read is reported as
 * `unsupported-paint` instead of silently dropping the paint. `context-fill` / `context-stroke` (taken from the `<use>` or marker, which
 * the converter does not track) paint nothing. An unparseable fallback color after `url(#…)` gives
 * the initial paint (the implicit black fill, no stroke). A whole declaration that is invalid never
 * gets here: resolveStyle ignores it, {@link warnIgnoredPaint} reports it.
 */
function solidPaint(
    ctx: ConvertContext,
    value: string | undefined,
    style: Inherited,
    property: 'fill' | 'stroke',
): ResolvedColor | null {
    if (value === undefined || isNone(value)) return null;
    const color = ctx.colors.paint(value, style.color);
    if (color) return color;
    const shown = value.trim();
    const context = CONTEXT_PAINT.test(shown);
    const fallback = property === 'fill' && !context && ctx.fillBlackForUnfilled ? INITIAL_FILL : null;
    const outcome = fallback ? 'using the initial black fill' : `the ${property} is dropped`;
    ctx.warn({
        code: 'unsupported-paint',
        message: context
            ? `${property}="${shown}" (context paint) cannot be resolved; ${outcome}.`
            : `${property}="${shown}" is not a color the converter can parse; ${outcome}.`,
        node: 'path',
    });
    return fallback ? { color: fallback, alpha: 1 } : null;
}

/**
 * Reports the invalid `fill` / `stroke` declaration resolveStyle ignored (`env()`, `var()`,
 * `color-mix()`, a typo…). CSS ignores it too: the presentation attribute under an invalid `style`
 * declaration applies, else the parent's value, else the initial one (black fill, no stroke).
 */
function warnIgnoredPaint(ctx: ConvertContext, style: Inherited, property: 'fill' | 'stroke'): void {
    const invalid = property === 'fill' ? style.fillInvalid : style.strokeInvalid;
    if (invalid === undefined) return;
    const applied = property === 'fill' ? style.fill : style.stroke;
    const outcome =
        applied !== undefined
            ? `${property}="${applied.trim()}" (attribute or inherited) applies`
            : property === 'fill' && ctx.fillBlackForUnfilled
              ? 'using the initial black fill'
              : `the ${property} is dropped`;
    ctx.warn({
        code: 'unsupported-paint',
        message: `${property}="${invalid}" is not a color the converter can parse; it is ignored, ${outcome}.`,
        node: 'path',
    });
}

/**
 * Why a `url(#id)` paint without fallback color draws nothing, null when `id` names no gradient.
 * A gradient element `collectGradients` left out is an invalid paint server (no usable stop, or a
 * non-invertible gradientTransform): SVG 2 §13.2 paints nothing for it (SVG 1.1 §13.2.4 likewise
 * for a gradient without stops).
 */
function invalidGradient(ctx: ConvertContext, ref: string, property: 'fill' | 'stroke'): string | null {
    if (!ctx.gradientIds.has(ref)) return null;
    return `${property}="url(#${ref})" points at a gradient that is not a valid paint server (no usable stop, or a non-invertible gradientTransform) and has no fallback color; the ${property} is not painted.`;
}

/** Emits the fill attributes; true when the fill is painted. */
function emitFill(ctx: ConvertContext, path: PathBuilder, style: Inherited): boolean {
    warnIgnoredPaint(ctx, style, 'fill');
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
        // An unknown reference keeps the documented black fill (SVG 2 would paint nothing here too).
        const invalid = invalidGradient(ctx, fill.ref, 'fill');
        ctx.warn({
            code: 'missing-gradient',
            message: invalid ?? `Path references unknown gradient "${fill.ref}"; using black.`,
            node: 'path',
        });
        if (!invalid) fillColor = '#000000';
    }
    // A missing reference with a fallback color is valid SVG: the fallback is the rendering.
    const color = solidPaint(ctx, fillColor, style, 'fill');
    if (color) path.attr('fillColor', color.color);

    const fillAlpha = alphaAttr(style.fillOpacity * style.opacityMul, color?.alpha ?? 1);
    if (fillAlpha !== null) path.attr('fillAlpha', fillAlpha);
    if (style.fillRule === 'evenodd') path.attr('fillType', 'evenOdd');
    return raw !== undefined || color !== null;
}

/** A painted stroke: a resolvable gradient or an Android color (literal or reference, see `ResolvedColor`). */
type StrokePaint = { gradient: RawGradient } | ResolvedColor;

/** Resolves the stroke paint (reporting unusable references); null when no stroke is painted. */
function resolveStroke(ctx: ConvertContext, style: Inherited): StrokePaint | null {
    warnIgnoredPaint(ctx, style, 'stroke');
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
                message:
                    invalidGradient(ctx, stroke.ref, 'stroke') ??
                    `Stroke references unknown paint "${stroke.ref}"; stroke dropped.`,
                node: 'path',
            });
    }
    if (strokeGradient) return { gradient: strokeGradient };
    return solidPaint(ctx, strokeColor, style, 'stroke');
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
                  ...(pathLength !== undefined && pathLength >= 0 ? { pathLength } : {}),
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
    const sa = alphaAttr(style.strokeOpacity * style.opacityMul, 'alpha' in paint ? paint.alpha : 1);
    if (sa !== null) path.attr('strokeAlpha', sa);
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

/** A path command letter, or a number in pathData (numbers first, so an exponent's `e` stays in its number). */
const PATH_TOKEN_RE = /([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z])/g;

/** Axis (0 = x, 1 = y) each argument of a command moves along; null for arc radii, rotation and flags. */
const ARG_AXES: Record<string, readonly (0 | 1 | null)[]> = {
    M: [0, 1],
    L: [0, 1],
    H: [0],
    V: [1],
    C: [0, 1, 0, 1, 0, 1],
    S: [0, 1, 0, 1],
    Q: [0, 1, 0, 1],
    T: [0, 1],
    A: [null, null, null, null, null, 0, 1],
    Z: [],
};

/**
 * Arc radii scale `λ` (SVG 2 implementation notes, B.2.5 step 3): a renderer scales the radii up by
 * `√λ` when λ > 1, i.e. when they are too small to join the end points. λ = 1 is a half-ellipse.
 */
function arcLambda(rx: number, ry: number, degrees: number, dx: number, dy: number): number {
    const phi = (degrees * Math.PI) / 180;
    const x = (Math.cos(phi) * dx + Math.sin(phi) * dy) / 2;
    const y = (-Math.sin(phi) * dx + Math.cos(phi) * dy) / 2;
    return (x * x) / (rx * rx) + (y * y) / (ry * ry);
}

/**
 * Distance from an arc's center to its chord midpoint, in half chords of the arc mapped to a unit
 * circle: 0 for a half-ellipse (λ ≥ 1). Near λ = 1 it is √(1/λ − 1), so a tiny change of the chord
 * moves the center a lot: that is what rounding a half-ellipse's end point does.
 */
function arcCenterOffset(lambda: number): number {
    return Math.sqrt(Math.max(0, 1 / lambda - 1));
}

/** A number of `d`: its source span `[begin, end)` and its new text (null: kept as written). */
interface NumberEdit {
    begin: number;
    end: number;
    text: string | null;
}

/**
 * Rounds the numbers of `d` that carry more than `precision` decimals, leaving everything else
 * (commands, separators, shorter numbers) byte-identical. A rounded number that lost its sign or
 * its dot is separated from a neighbour it would otherwise merge with (`1-0.00001` → `1 0`,
 * `1.00001.5` → `1 .5`). Arc flags must already be separated (see `normalizeArcFlags`).
 *
 * Coordinates are rounded in absolute space: a rounded relative coordinate is the rounded absolute
 * point minus the current point as written, so rounding errors do not add up along a run of
 * relative commands; a number kept as written leaves the gap unchanged. Every point thus stays
 * within half a unit of `precision` of the source. Rotation and flags are rounded on their own, and
 * so is every number past malformed data.
 *
 * Arc radii are rounded on their own too, except near a half-ellipse (as a `<circle>` gives): its
 * center moves by about √(2r·δ) when rounding shortens the chord by δ. When the source center is
 * nearer the chord midpoint than the rounded arc's center, the radii are rounded down to fit the
 * rounded chord, which renderers scale back up to an exact half-ellipse.
 */
export function roundPathNumbers(d: string, precision: number): string {
    if (!(d.match(PATH_NUMBER_RE) ?? []).some((literal) => decimalsOf(literal) > precision)) return d;
    const unit = 10 ** -precision;
    // Current point and subpath start, exact (source) and as written out (rounded).
    let pen: [number, number] = [0, 0];
    let start: [number, number] = [0, 0];
    let outPen: [number, number] = [0, 0];
    let outStart: [number, number] = [0, 0];
    // The argument group being read: source values (coordinates made absolute), written values, edits.
    let args: number[] = [];
    let outArgs: number[] = [];
    let groupEdits: NumberEdit[] = [];
    let cmd: string | null = null;
    let tracking = true;
    const edits: NumberEdit[] = [];

    for (const m of d.matchAll(PATH_TOKEN_RE)) {
        const letter = m[2];
        if (letter !== undefined) {
            if (!(letter.toUpperCase() in ARG_AXES)) tracking = false;
            cmd = letter;
            [args, outArgs, groupEdits] = [[], [], []];
            if (letter === 'Z' || letter === 'z') {
                pen = [...start];
                outPen = [...outStart];
            }
            continue;
        }
        const literal = m[1]!;
        const value = parseFloat(literal);
        const fits = decimalsOf(literal) <= precision;
        const edit: NumberEdit = {
            begin: m.index,
            end: m.index + literal.length,
            text: fits ? null : formatNumber(value, precision),
        };
        edits.push(edit);
        const upper = cmd?.toUpperCase();
        const axes = upper === undefined ? undefined : ARG_AXES[upper];
        // A number before any command or after a closepath is malformed data.
        if (!axes?.length) tracking = false;
        if (!tracking || !cmd || !upper || !axes) continue;

        const axis = axes[args.length];
        const relative = cmd !== upper;
        let source = value;
        let written = fits ? value : parseFloat(edit.text!);
        if (axis !== null && axis !== undefined) {
            if (relative) source += pen[axis];
            if (fits) {
                // Kept as written: the gap to the source point stays what it was.
                if (relative) written = outPen[axis] + value;
            } else {
                written = parseFloat(formatNumber(source, precision));
                if (relative) edit.text = formatNumber(written - outPen[axis], precision);
            }
        }
        args.push(source);
        outArgs.push(written);
        groupEdits.push(edit);
        if (args.length < axes.length) continue;

        // Group complete: its last x and y are the new current point (H and V move one axis).
        const next: [number, number] = [...pen];
        const outNext: [number, number] = [...outPen];
        axes.forEach((a, i) => {
            if (a === null) return;
            next[a] = args[i]!;
            outNext[a] = outArgs[i]!;
        });
        if (upper === 'A') {
            // Negative radii are taken as their absolute value (SVG 2 implementation notes, B.2.5 step 1).
            const [rx, ry, outRx, outRy] = [args[0]!, args[1]!, outArgs[0]!, outArgs[1]!].map(Math.abs) as [
                number,
                number,
                number,
                number,
            ];
            const lambda = arcLambda(rx, ry, args[2]!, next[0] - pen[0], next[1] - pen[1]);
            const outLambda = arcLambda(outRx, outRy, outArgs[2]!, outNext[0] - outPen[0], outNext[1] - outPen[1]);
            const offset = arcCenterOffset(lambda);
            // The source center is nearer the chord midpoint than the rounded arc's: fit the radii.
            if (outLambda > 0 && outLambda < 1 && offset < arcCenterOffset(outLambda) - offset) {
                const scale = Math.sqrt(outLambda);
                [outRx, outRy].forEach((r, i) => {
                    groupEdits[i]!.text = formatNumber(Math.floor((r * scale) / unit) * unit, precision);
                });
            }
        }
        pen = next;
        outPen = outNext;
        if (upper === 'M') {
            start = [...pen];
            outStart = [...outPen];
            // Further pairs after a moveto are implicit linetos.
            cmd = relative ? 'l' : 'L';
        }
        [args, outArgs, groupEdits] = [[], [], []];
    }

    let out = '';
    let last = 0;
    for (const { begin, end, text } of edits) {
        if (text === null) continue;
        let rounded = text;
        out += d.slice(last, begin);
        if (/^\d/.test(rounded) && /[\d.]$/.test(out)) rounded = ` ${rounded}`;
        if (d[end] === '.' && !rounded.includes('.')) rounded += ' ';
        out += rounded;
        last = end;
    }
    return out + d.slice(last);
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
