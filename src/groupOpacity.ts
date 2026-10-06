import type { ConvertContext } from './context.js';
import { GROUPS, isDisplayNone, pathDataOf, SKIP, UNSUPPORTED } from './elements.js';
import type { BBox, XastElement } from './gradient.js';
import { fillOf, isHidden, resolveStyle, strokeWidthOf, type Inherited } from './inherited.js';
import { pathBBox, transformPathData } from './pathData.js';
import { isNone, presentation } from './style.js';
import { IDENTITY, multiply, parseTransform, scaleFactor, type Matrix } from './transform.js';
import { parseOpacity } from './units.js';
import { nestedLayout } from './viewport.js';

const intersect = (a: BBox, b: BBox): BBox | null => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
};

const overlaps = (a: BBox, b: BBox): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Painted extents (stroke included) of every drawable under `el`, in `el`'s user space. Used to
 * tell whether folding a group opacity onto its children changes the rendering.
 */
function drawableBoxes(ctx: ConvertContext, el: XastElement, parent: Inherited, m: Matrix, out: BBox[]): void {
    for (const c of el.children ?? []) {
        if (c.type !== 'element' || !c.name || SKIP.has(c.name) || UNSUPPORTED.has(c.name)) continue;
        if (isDisplayNone(c)) continue;
        const st = resolveStyle(c, parent);
        const own = parseTransform(c.attributes?.transform);
        const mm = own ? multiply(m, own) : m;
        if (GROUPS.has(c.name)) {
            drawableBoxes(ctx, c, st, mm, out);
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
        const fillOn = !isNone(fillOf(st, ctx.fillBlackForUnfilled));
        const strokeOn = !isNone(st.stroke);
        if (!fillOn && !strokeOn) continue;
        const box = pathBBox(transformPathData(d, mm));
        if (!box) continue;
        const half = strokeOn ? (strokeWidthOf(st) / 2) * scaleFactor(mm) : 0;
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
