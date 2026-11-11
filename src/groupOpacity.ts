import type { ConvertContext } from './context.js';
import { GROUPS, isNotRendered, pathDataOf, switchChild, UNSUPPORTED } from './elements.js';
import type { BBox, XastElement } from './ast.js';
import { fillOf, isHidden, resolveStyle, strokeWidthOf, type Inherited } from './inherited.js';
import { pathBBox, transformPathData } from './pathData.js';
import { parsePath } from './pathParse.js';
import { isNone, presentation } from './style.js';
import { IDENTITY, maxStretch, multiply, parseTransform, type Matrix } from './transform.js';
import { parseOpacity } from './units.js';
import { nestedLayout } from './viewport.js';

const intersect = (a: BBox, b: BBox): BBox | null => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
};

/** true when some subpath of `d` has a corner: two segments in a row, or a segment then a close. */
function hasJoin(d: string): boolean {
    let segments = 0;
    for (const { cmd } of parsePath(d)) {
        if (cmd === 'M' || cmd === 'm') segments = 0;
        else if (cmd === 'Z' || cmd === 'z') {
            if (segments > 0) return true;
            segments = 0;
        } else if (++segments > 1) return true;
    }
    return false;
}

/**
 * How far the stroke of path `d` can reach past its bounding box: half its width, times `√2` for
 * a square cap (its corners) and times the miter limit for a miter join when `d` has a corner (the
 * tip of a sharp one), scaled by `stretch` (see {@link maxStretch}). `join` is the one drawn:
 * anything but `round` / `bevel` renders as a miter (VectorDrawable's default, also used for
 * `miter-clip` / `arcs`).
 */
export function strokeMargin(
    d: string,
    width: number,
    cap: string | undefined,
    join: string | undefined,
    miterLimit: number,
    stretch: number,
): number {
    const capFactor = cap === 'square' ? Math.SQRT2 : 1;
    const miter = join !== 'round' && join !== 'bevel' && miterLimit > 1 && hasJoin(d);
    return (width / 2) * Math.max(capFactor, miter ? miterLimit : 1) * stretch;
}

/** `url(…)` (quoted or not) and its optional fallback, as `src/paint.ts` parses a paint. */
const URL_PAINT = /^url\(\s*(?:'([^']*)'|"([^"]*)"|([^'"()\s]*))\s*\)\s*(.*)$/is;
const CONTEXT_PAINT = /^context-(?:fill|stroke)$/i;

/**
 * True when the `fill` / `stroke` paint `raw` draws something, as `renderPath` decides it (without
 * its warnings), the same rule as `PathBuilder.paints`: a gradient with stops (it wins over a
 * fallback color), else the solid color (the fallback of a `url(…)` to a pattern, another document
 * or nothing), non-transparent, with a non-zero alpha. An unparseable fill color stands for the
 * initial black when `fillBlackForUnfilled` (not a context paint).
 */
function paintsWith(ctx: ConvertContext, raw: string, style: Inherited, property: 'fill' | 'stroke'): boolean {
    if (isNone(raw)) return false;
    const opacity = (property === 'fill' ? style.fillOpacity : style.strokeOpacity) * style.opacityMul;
    if (!(opacity > 0)) return false;
    let value = raw.trim();
    const m = URL_PAINT.exec(value);
    if (m) {
        const url = (m[1] ?? m[2] ?? m[3]!).trim();
        const gradient = url.startsWith('#') ? ctx.gradients.get(url.slice(1)) : undefined;
        if (gradient) return gradient.stops.length > 0;
        value = m[4]!.trim();
        if (!value) return false;
    }
    const color = ctx.colors.paint(value, style.color);
    if (!color) return property === 'fill' && ctx.fillBlackForUnfilled && !CONTEXT_PAINT.test(value);
    return !/^#00/.test(color.color) && color.alpha > 0;
}

const overlaps = (a: BBox, b: BBox): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Painted extents (stroke included) of every drawable under `el`, in `el`'s user space. Used to
 * tell whether folding a group opacity onto its children changes the rendering. Skips what the
 * renderer skips (`isNotRendered`, unsupported elements, a fill / stroke that paints nothing: see
 * {@link paintsWith}), so a child that draws nothing never counts as overlapping (nor does a
 * foreign element, `ctx.foreign`).
 */
function drawableBoxes(ctx: ConvertContext, el: XastElement, parent: Inherited, m: Matrix, out: BBox[]): void {
    const { foreign } = ctx;
    for (const c of el.children ?? []) {
        if (c.type !== 'element' || !c.name || isNotRendered(c, foreign) || UNSUPPORTED.has(c.name)) continue;
        const st = resolveStyle(c, parent);
        const own = parseTransform(c.attributes?.transform);
        const mm = own ? multiply(m, own) : m;
        if (GROUPS.has(c.name)) {
            drawableBoxes(ctx, c, st, mm, out);
            continue;
        }
        if (c.name === 'switch') {
            const { child } = switchChild(c, foreign);
            if (child) drawableBoxes(ctx, { ...c, children: [child] }, st, mm, out);
            continue;
        }
        if (c.name === 'svg') {
            const layout = nestedLayout(c, st.viewport);
            if (!layout) continue;
            const inner: BBox[] = [];
            drawableBoxes(ctx, c, { ...st, viewport: layout.viewport }, multiply(mm, layout.matrix), inner);
            const { x, y, width, height } = layout;
            const clip = layout.clipped
                ? pathBBox(transformPathData(`M${x},${y}h${width}v${height}h${-width}z`, mm))
                : null;
            for (const box of inner) {
                const visible = clip ? intersect(box, clip) : box;
                if (visible) out.push(visible);
            }
            continue;
        }
        if (isHidden(st)) continue;
        const d = pathDataOf(c, st.viewport, ctx.precision);
        if (!d) continue;
        const fillOn = paintsWith(ctx, fillOf(st, ctx.fillBlackForUnfilled), st, 'fill');
        // Width 0 draws nothing (PathBuilder.paints).
        const strokeOn = st.stroke !== undefined && paintsWith(ctx, st.stroke, st, 'stroke') && strokeWidthOf(st) !== 0;
        if (!fillOn && !strokeOn) continue;
        const box = pathBBox(transformPathData(d, mm));
        if (!box) continue;
        const miterLimit = parseFloat(st.strokeMiterlimit ?? '');
        const half = strokeOn
            ? strokeMargin(
                  d,
                  strokeWidthOf(st),
                  st.strokeLinecap,
                  st.strokeLinejoin,
                  Number.isNaN(miterLimit) ? 4 : miterLimit,
                  maxStretch(mm),
              )
            : 0;
        out.push({ x: box.x - half, y: box.y - half, width: box.width + 2 * half, height: box.height + 2 * half });
    }
}

/**
 * Group opacity is folded onto each leaf's alpha, which is exact only when no two children
 * overlap: warns otherwise.
 */
export function checkGroupOpacity(ctx: ConvertContext, g: XastElement, parent: Inherited): void {
    const op = presentation(g, 'opacity');
    if (op === undefined || !(parseOpacity(op) < 1)) return;
    const boxes: BBox[] = [];
    drawableBoxes(ctx, g, { ...resolveStyle(g, parent), opacityMul: 1 }, IDENTITY, boxes);
    for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
            if (overlaps(boxes[i]!, boxes[j]!)) {
                ctx.warn({
                    code: 'opacity-approximated',
                    message:
                        'Group opacity is folded onto overlapping children; overlaps will render darker than in the SVG.',
                    node: 'g',
                });
                return;
            }
}
