/**
 * SVG → Jetpack Compose `ImageVector` (Kotlin source).
 *
 * Built on top of `convert`: the SVG is converted to VectorDrawable XML first, then that XML (parsed
 * with the preview's parser) is serialized as an `ImageVector.Builder` call. A VectorDrawable and an
 * `ImageVector` share the same model (Compose's own XML loader maps one onto the other), so every
 * normalization, warning, `strict` and `rules` decision is exactly that of `convert`; only what an
 * `ImageVector` cannot express adds a warning here:
 * - a color reference (`?attr/…`, `@color/…`, from `currentColor` / `colorMap`) has no value outside
 *   an app: drawn in {@link UNRESOLVED_COLOR}, with an `unsupported-color-reference` warning;
 * - the root `opacity` (`android:alpha`) has no `ImageVector` equivalent: folded into the alpha of
 *   every path, with an `opacity-approximated` warning when two paints may overlap (overlaps render
 *   darker): the fill and stroke of one path, or two paints whose extents intersect.
 *
 * Mapping: `<group>` → `group(…)` (same scale → rotate → translate order around the pivot);
 * `<clip-path>` → a `group(clipPathData = PathData { … })` wrapping its following siblings (both
 * clip in the group's coordinates); `<path>` → `path(…) { moveTo(…) … }` with `SolidColor` or
 * `Brush.linearGradient` / `radialGradient` / `sweepGradient` paints (viewport coordinates, as in
 * the XML) and `PathFillType.EvenOdd` for `android:fillType="evenOdd"`. An icon too large for one JVM
 * method (see {@link METHOD_BUDGET}) has its statements moved into private objects after the `val`.
 */
import type { BBox } from './ast.js';
import { convert, warningSink } from './convert.js';
import { strokeMargin } from './groupOpacity.js';
import { pathBBox, transformPathData } from './pathData.js';
import { parsePath } from './pathParse.js';
import { parseAndroidColor, parseXml, UNRESOLVED_COLOR, type XmlNode } from './preview.js';
import { IDENTITY, isIdentity, maxStretch, multiply, parseTransform, type Matrix } from './transform.js';
import type { ImageVectorOptions, ImageVectorResult, Warning } from './types.js';

const STEP = '    ';

/** Kotlin hard keywords: not usable as a package segment without backticks. */
const KOTLIN_KEYWORDS = new Set(
    'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(
        ' ',
    ),
);

/**
 * A valid PascalCase Kotlin identifier for `raw`: accents stripped, split on every character that is
 * not an ASCII letter or digit, each part capitalized (`ic_arrow-back` → `IcArrowBack`, `arrowBack` →
 * `ArrowBack`); a leading digit gets an `Icon` prefix (`24px` → `Icon24px`). Throws a `TypeError` when
 * nothing is left.
 */
export function kotlinName(raw: string): string {
    if (typeof raw !== 'string') throw new TypeError(`Invalid name: ${String(raw)} (expected a string)`);
    const parts = raw
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
    if (parts.length === 0)
        throw new TypeError(`Invalid name ${JSON.stringify(raw)} (expected at least one ASCII letter or digit)`);
    const id = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
    return /^[0-9]/.test(id) ? `Icon${id}` : id;
}

/** Validates a Kotlin package name (`com.example.icons`); keyword segments are backquoted. */
export function kotlinPackage(name: string): string {
    const segments = typeof name === 'string' ? name.split('.') : [];
    if (segments.length === 0 || !segments.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && /[A-Za-z0-9]/.test(s)))
        throw new TypeError(`Invalid packageName ${JSON.stringify(name)} (expected e.g. com.example.icons)`);
    return segments.map((s) => (KOTLIN_KEYWORDS.has(s) ? `\`${s}\`` : s)).join('.');
}

/** Escapes of the characters a Kotlin string literal cannot hold as is (`$` would start a template). */
const KOTLIN_ESCAPES: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    $: '\\$',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
};

/** A Kotlin string literal; other control characters become `\uXXXX`. */
const kotlinString = (s: string): string =>
    `"${[...s]
        .map((c) => KOTLIN_ESCAPES[c] ?? (c < ' ' ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c))
        .join('')}"`;

/** A number as written in the XML, as a Kotlin `Float` literal (`.5` → `0.5f`, `-0` → `0f`). */
const float = (n: number): string => `${Object.is(n, -0) ? 0 : n}f`;

/** An alpha product, rounded below what an 8-bit alpha resolves. */
const alphaValue = (v: number): number => Math.round(v * 1e4) / 1e4;

/** A numeric `android:` attribute; malformed: `Error` (the converter never writes one). */
function num(attrs: Record<string, string>, key: string, fallback: number): number {
    const raw = attrs[`android:${key}`];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`android:${key}="${raw}" is not a number`);
    return n;
}

/** `@[package:]color/name` or `?[package:]attr/name` (as in `src/colorRef.ts`). */
const REFERENCE_RE =
    /^(?:@(?:[a-zA-Z_][a-zA-Z0-9_.]*:)?color|\?(?:[a-zA-Z_][a-zA-Z0-9_.]*:)?attr)\/[a-zA-Z_][a-zA-Z0-9_.]*$/;

const CAPS: Record<string, string> = { butt: 'Butt', round: 'Round', square: 'Square' };
const JOINS: Record<string, string> = { miter: 'Miter', round: 'Round', bevel: 'Bevel' };
const TILE_MODES: Record<string, string> = { clamp: 'Clamp', repeated: 'Repeated', mirror: 'Mirror' };

/** Compose `PathBuilder` method of each path command letter (lowercase: the relative variant). */
const PATH_METHODS: Record<string, string> = {
    M: 'moveTo',
    m: 'moveToRelative',
    L: 'lineTo',
    l: 'lineToRelative',
    H: 'horizontalLineTo',
    h: 'horizontalLineToRelative',
    V: 'verticalLineTo',
    v: 'verticalLineToRelative',
    C: 'curveTo',
    c: 'curveToRelative',
    S: 'reflectiveCurveTo',
    s: 'reflectiveCurveToRelative',
    Q: 'quadTo',
    q: 'quadToRelative',
    T: 'reflectiveQuadTo',
    t: 'reflectiveQuadToRelative',
    A: 'arcTo',
    a: 'arcToRelative',
};

/**
 * Bytecode budget of one Kotlin method, in units of about 20 bytes (one path command: 17 bytes for a
 * `curveTo`, 22 for an `arcTo`). `path {}`, `group {}` and `PathData {}` are `inline`: unsplit, the whole
 * icon is compiled into the single lambda of `by lazy`, and the JVM caps a method at 64 KiB of bytecode
 * (`Method too large` past ~3,600 `curveTo`). 2,000 units stay below 45 KiB; an icon within the budget is
 * written in one block, as before.
 */
const METHOD_BUDGET = 2000;
/**
 * Name of the one function of each split-out part object. Not `build`: inside `with(Part) { … }` in an
 * `ImageVector.Builder` scope, the builder's own `build()` member would win over the part's extension.
 */
const PART_FN = 'content';
/** Units of a `path(…)` / `group(…)` call itself (the inlined builder call), plus one per argument line. */
const CALL_COST = 5;

/** Kotlin statements at zero indentation, with their cost in budget units. */
interface Block {
    code: string;
    cost: number;
}

/** State of one serialization. */
interface Ctx {
    imports: Set<string>;
    warn: (w: Warning) => void;
    /** Color references already reported (one warning each). */
    unresolved: Set<string>;
    /** Root `android:alpha`, folded into every path's alpha. */
    alpha: number;
    /**
     * Painted extents (stroke included, viewport coordinates) of the paints drawn so far, tracked
     * only under a root alpha; `null`: unknown, overlaps everything.
     */
    boxes: (BBox | null)[];
    /** Two paints drawn so far may overlap (the root alpha folded on each is then approximate). */
    overlap: boolean;
    /** Current group → viewport matrix; `null` under a clip-path or an unresolved group transform. */
    matrix: Matrix | null;
    /** Name prefix of the split-out objects (`ArrowBack` → `ArrowBackPart1`). */
    partPrefix: string;
    /** Private top-level objects split out of the builder, in creation order. */
    parts: string[];
}

/** `code` with every non-empty line indented by `pad`. */
const indent = (code: string, pad: string): string => code.replace(/^(?=.)/gm, pad);

/**
 * Sibling statements as one block: inline when they fit {@link METHOD_BUDGET}, else packed in order
 * into private objects of even size, each with one extension function of `receiver`
 * (`ImageVector.Builder` or `PathBuilder`, both receivers of the inline lambdas), the block then being
 * their calls (`with(IconPart1) { content() }`). An object is a JVM class of its own, so each part has
 * its own constant pool (65,535 entries): top-level functions would all share the file class's, which
 * overflows past ~65,000 distinct numbers (`ClassTooLargeException`).
 */
function statements(items: Block[], receiver: string, ctx: Ctx): Block {
    const blocks = items.filter((b) => b.code);
    const cost = blocks.reduce((sum, b) => sum + b.cost, 0);
    if (cost <= METHOD_BUDGET) return { code: blocks.map((b) => b.code).join('\n'), cost };
    if (receiver === 'PathBuilder') use(ctx, 'androidx.compose.ui.graphics.vector.PathBuilder');
    // As few functions as the budget allows, evenly filled (no 1-command tail).
    const target = Math.ceil(cost / Math.ceil(cost / METHOD_BUDGET));
    const calls: Block[] = [];
    let chunk: string[] = [];
    let chunkCost = 0;
    const flush = (): void => {
        const part = `${ctx.partPrefix}Part${ctx.parts.length + 1}`;
        const body = indent(chunk.join('\n'), STEP + STEP);
        ctx.parts.push(`private object ${part} {\n${STEP}fun ${receiver}.${PART_FN}() {\n${body}\n${STEP}}\n}`);
        calls.push({ code: `with(${part}) { ${PART_FN}() }`, cost: 1 });
        chunk = [];
        chunkCost = 0;
    };
    for (const b of blocks) {
        if (chunk.length > 0 && chunkCost + b.cost > target) flush();
        chunk.push(b.code);
        chunkCost += b.cost;
    }
    flush();
    return statements(calls, receiver, ctx);
}

const use = (ctx: Ctx, fqName: string): void => void ctx.imports.add(fqName);

/** `Color(0xAARRGGBB)` of an Android color literal; a reference is drawn in the placeholder color. */
function color(value: string, ctx: Ctx): string {
    let literal = value.trim();
    if (REFERENCE_RE.test(literal)) {
        if (!ctx.unresolved.has(literal)) {
            ctx.unresolved.add(literal);
            ctx.warn({
                code: 'unsupported-color-reference',
                message: `The color reference ${literal} cannot be expressed in an ImageVector (no app resources); drawn in ${UNRESOLVED_COLOR}. Use a color literal (currentColor / colorMap), or tint the icon where it is drawn.`,
                node: 'path',
            });
        }
        literal = UNRESOLVED_COLOR;
    }
    const { rgb, opacity } = parseAndroidColor(literal);
    const a = Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0');
    use(ctx, 'androidx.compose.ui.graphics.Color');
    return `Color(0x${(a + rgb.slice(1)).toUpperCase()})`;
}

/** A `Brush.*Gradient(…)` call for an Android `<gradient>`. */
function gradient(g: XmlNode, ctx: Ctx): string {
    const a = g.attrs;
    const stops: [number, string][] = [];
    const items = g.children.filter((c) => c.name === 'item');
    if (items.length > 0) {
        for (const item of items) {
            const value = item.attrs['android:color'];
            if (value === undefined) throw new Error('<item> without android:color');
            stops.push([num(item.attrs, 'offset', 0), value]);
        }
    } else {
        const ends: [number, string | undefined][] = [
            [0, a['android:startColor']],
            [0.5, a['android:centerColor']],
            [1, a['android:endColor']],
        ];
        for (const [offset, value] of ends) if (value) stops.push([offset, value]);
    }
    use(ctx, 'androidx.compose.ui.graphics.Brush');
    use(ctx, 'androidx.compose.ui.geometry.Offset');
    const args = stops.map(([offset, value]) => `${float(offset)} to ${color(value, ctx)}`);
    const offset = (x: string, y: string): string => `Offset(${float(num(a, x, 0))}, ${float(num(a, y, 0))})`;
    const type = a['android:type'] ?? 'linear';
    if (type === 'linear') args.push(`start = ${offset('startX', 'startY')}`, `end = ${offset('endX', 'endY')}`);
    else if (type === 'radial')
        args.push(`center = ${offset('centerX', 'centerY')}`, `radius = ${float(num(a, 'gradientRadius', 0))}`);
    else if (type === 'sweep') args.push(`center = ${offset('centerX', 'centerY')}`);
    else throw new Error(`Unsupported gradient android:type="${type}"`);
    const tile = a['android:tileMode'] ?? 'clamp';
    const mode = TILE_MODES[tile];
    if (!mode) throw new Error(`Unsupported android:tileMode="${tile}"`);
    // Sweep gradients have no tile mode; clamp is the default of the others.
    if (type !== 'sweep' && mode !== 'Clamp') {
        use(ctx, 'androidx.compose.ui.graphics.TileMode');
        args.push(`tileMode = TileMode.${mode}`);
    }
    return `Brush.${type}Gradient(\n${args.map((arg) => `${STEP}${arg},\n`).join('')})`;
}

/** The brush of a path paint (`fillColor` / `strokeColor`): attribute or `<aapt:attr>` gradient. */
function brush(path: XmlNode, key: 'fillColor' | 'strokeColor', ctx: Ctx): string | null {
    const aapt = path.children.find((c) => c.name === 'aapt:attr' && c.attrs.name === `android:${key}`);
    if (aapt) {
        const g = aapt.children.find((c) => c.name === 'gradient');
        if (!g) throw new Error(`<aapt:attr name="android:${key}"> without <gradient>`);
        return gradient(g, ctx);
    }
    const value = path.attrs[`android:${key}`];
    if (value === undefined) return null;
    use(ctx, 'androidx.compose.ui.graphics.SolidColor');
    return `SolidColor(${color(value, ctx)})`;
}

/** `PathBuilder` calls of a path-data string, one per line. */
function pathCommands(d: string, ctx: Ctx): Block {
    const calls = parsePath(d).map(({ cmd, args }): Block => {
        if (cmd === 'Z' || cmd === 'z') return { code: 'close()', cost: 1 };
        const values = args.map(float);
        // Arc flags are booleans: large-arc (isMoreThanHalf) and sweep (isPositiveArc).
        if (cmd === 'A' || cmd === 'a') {
            values[3] = String(args[3] !== 0);
            values[4] = String(args[4] !== 0);
        }
        return { code: `${PATH_METHODS[cmd]!}(${values.join(', ')})`, cost: 1 };
    });
    return statements(calls, 'PathBuilder', ctx);
}

/**
 * A call with named arguments, one per line (an argument's own lines are indented with it), then a
 * trailing lambda (`body`); its cost is the body's plus {@link CALL_COST} and the argument lines.
 */
function call(fn: string, args: string[], body: Block): Block {
    const head = args.length === 0 ? fn : `${fn}(\n${indent(args.map((a) => `${a},`).join('\n'), STEP)}\n)`;
    const code = `${head} {\n${body.code ? `${indent(body.code, STEP)}\n` : ''}}`;
    // A gradient stop, a color or an offset costs about one unit: count the argument lines.
    const argLines = args.reduce((n, a) => n + a.split('\n').length, 0);
    return { code, cost: body.cost + CALL_COST + argLines };
}

const overlaps = (a: BBox | null, b: BBox | null): boolean =>
    !a || !b || (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height);

/**
 * Records the paints of one path for the root-alpha overlap check: its fill and stroke overlap each
 * other; otherwise its extent (path box widened by {@link strokeMargin}) is tested against the
 * paints drawn before it.
 */
function trackPaints(d: string, fill: boolean, strokeWidth: number, a: Record<string, string>, ctx: Ctx): void {
    if (ctx.alpha === 1 || ctx.overlap || (!fill && strokeWidth === 0)) return;
    if (fill && strokeWidth > 0) {
        ctx.overlap = true;
        return;
    }
    const m = ctx.matrix;
    let extent: BBox | null = null;
    if (m) {
        const box = pathBBox(isIdentity(m) ? d : transformPathData(d, m));
        if (!box) return; // Nothing drawn.
        const cap = a['android:strokeLineCap'];
        const join = a['android:strokeLineJoin'];
        const half = strokeMargin(d, strokeWidth, cap, join, num(a, 'strokeMiterLimit', 4), maxStretch(m));
        extent = { x: box.x - half, y: box.y - half, width: box.width + 2 * half, height: box.height + 2 * half };
    }
    if (ctx.boxes.some((b) => overlaps(b, extent))) ctx.overlap = true;
    ctx.boxes.push(extent);
}

/** Android group matrix: translate(t + pivot) · rotate · scale · translate(−pivot). */
function groupMatrix(a: Record<string, string>): Matrix | null {
    const px = num(a, 'pivotX', 0);
    const py = num(a, 'pivotY', 0);
    return parseTransform(
        `translate(${num(a, 'translateX', 0) + px} ${num(a, 'translateY', 0) + py}) rotate(${num(a, 'rotation', 0)}) ` +
            `scale(${num(a, 'scaleX', 1)} ${num(a, 'scaleY', 1)}) translate(${-px} ${-py})`,
    );
}

function pathCall(node: XmlNode, ctx: Ctx): Block {
    const a = node.attrs;
    const d = a['android:pathData'];
    if (!d) return { code: '', cost: 0 };
    const args: string[] = [];
    if (a['android:name'] !== undefined) args.push(`name = ${kotlinString(a['android:name'])}`);
    const fill = brush(node, 'fillColor', ctx);
    if (fill) {
        args.push(`fill = ${fill}`);
        const alpha = alphaValue(num(a, 'fillAlpha', 1) * ctx.alpha);
        if (alpha !== 1) args.push(`fillAlpha = ${float(alpha)}`);
    }
    const width = num(a, 'strokeWidth', 0);
    const stroke = width > 0 ? brush(node, 'strokeColor', ctx) : null;
    trackPaints(d, fill !== null, stroke ? width : 0, a, ctx);
    if (stroke) {
        args.push(`stroke = ${stroke}`);
        const alpha = alphaValue(num(a, 'strokeAlpha', 1) * ctx.alpha);
        if (alpha !== 1) args.push(`strokeAlpha = ${float(alpha)}`);
        args.push(`strokeLineWidth = ${float(width)}`);
        const cap = a['android:strokeLineCap'];
        if (cap !== undefined && cap !== 'butt') {
            if (!CAPS[cap]) throw new Error(`Unsupported android:strokeLineCap="${cap}"`);
            use(ctx, 'androidx.compose.ui.graphics.StrokeCap');
            args.push(`strokeLineCap = StrokeCap.${CAPS[cap]}`);
        }
        const join = a['android:strokeLineJoin'];
        if (join !== undefined && join !== 'miter') {
            if (!JOINS[join]) throw new Error(`Unsupported android:strokeLineJoin="${join}"`);
            use(ctx, 'androidx.compose.ui.graphics.StrokeJoin');
            args.push(`strokeLineJoin = StrokeJoin.${JOINS[join]}`);
        }
        const miter = num(a, 'strokeMiterLimit', 4);
        if (miter !== 4) args.push(`strokeLineMiter = ${float(miter)}`);
    }
    if (a['android:fillType'] === 'evenOdd') {
        use(ctx, 'androidx.compose.ui.graphics.PathFillType');
        args.push('pathFillType = PathFillType.EvenOdd');
    }
    use(ctx, 'androidx.compose.ui.graphics.vector.path');
    return call('path', args, pathCommands(d, ctx));
}

/** Android group attributes → Compose `group` arguments (defaults omitted). */
const GROUP_ARGS: [string, string, number][] = [
    ['rotation', 'rotate', 0],
    ['pivotX', 'pivotX', 0],
    ['pivotY', 'pivotY', 0],
    ['scaleX', 'scaleX', 1],
    ['scaleY', 'scaleY', 1],
    ['translateX', 'translationX', 0],
    ['translateY', 'translationY', 0],
];

/** Serializes a group's children; each `<clip-path>` becomes a group clipping the siblings after it. */
function childrenCalls(children: XmlNode[], ctx: Ctx): Block {
    const out: Block[] = [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (child.name === 'clip-path') {
            use(ctx, 'androidx.compose.ui.graphics.vector.group');
            use(ctx, 'androidx.compose.ui.graphics.vector.PathData');
            const d = child.attrs['android:pathData'] ?? '';
            // The clip commands (or the calls of their split-out parts) are argument lines: counted by `call`.
            const clip = `clipPathData = PathData {\n${indent(pathCommands(d, ctx).code, STEP)}\n}`;
            // Paints under a clip are not tracked: each overlaps everything.
            const matrix = ctx.matrix;
            ctx.matrix = null;
            out.push(call('group', [clip], childrenCalls(children.slice(i + 1), ctx)));
            ctx.matrix = matrix;
            break;
        }
        if (child.name === 'path') out.push(pathCall(child, ctx));
        else if (child.name === 'group') {
            const a = child.attrs;
            const args: string[] = [];
            if (a['android:name'] !== undefined) args.push(`name = ${kotlinString(a['android:name'])}`);
            for (const [attr, param, neutral] of GROUP_ARGS) {
                const v = num(a, attr, neutral);
                if (v !== neutral) args.push(`${param} = ${float(v)}`);
            }
            use(ctx, 'androidx.compose.ui.graphics.vector.group');
            const matrix = ctx.matrix;
            const own = matrix && groupMatrix(a);
            ctx.matrix = own && multiply(matrix, own);
            out.push(call('group', args, childrenCalls(child.children, ctx)));
            ctx.matrix = matrix;
        } else throw new Error(`Unsupported VectorDrawable element <${child.name}>`);
    }
    return statements(out, 'ImageVector.Builder', ctx);
}

/**
 * Converts an SVG string into a Kotlin file declaring a Jetpack Compose `ImageVector`, built lazily
 * on first use: `val <Name>: ImageVector by lazy { ImageVector.Builder(…).apply { … }.build() }`.
 * Same options, warnings, `strict` and `rules` as `convert` (see the module documentation for what
 * an `ImageVector` adds), plus `name` and `packageName`.
 *
 * ```ts
 * import { toImageVector } from 'svg-vectordrawable';
 * const { kotlin } = toImageVector(svg, { name: 'arrow_back', packageName: 'com.example.icons' });
 * // kotlin declares `val ArrowBack: ImageVector`
 * ```
 */
export function toImageVector(svg: string, options: ImageVectorOptions): ImageVectorResult {
    const { name: rawName, packageName, ...convertOptions } = options ?? ({} as ImageVectorOptions);
    const name = kotlinName(rawName);
    const pkg = packageName === undefined ? undefined : kotlinPackage(packageName);
    // XML-only options do not reach the conversion (indent / xmlTag change nothing; minSdk targets the framework).
    const {
        indent: _i,
        xmlTag: _x,
        minSdk: _m,
        ...rest
    } = convertOptions as ImageVectorOptions & {
        indent?: unknown;
        xmlTag?: unknown;
        minSdk?: unknown;
    };
    const { xml, warnings } = convert(svg, rest);
    const { warn } = warningSink(rest, warnings);

    const vector = parseXml(xml);
    const a = vector.attrs;
    const ctx: Ctx = {
        imports: new Set(),
        warn,
        unresolved: new Set(),
        alpha: num(a, 'alpha', 1),
        boxes: [],
        overlap: false,
        matrix: IDENTITY,
        partPrefix: name,
        parts: [],
    };
    use(ctx, 'androidx.compose.ui.graphics.vector.ImageVector');
    use(ctx, 'androidx.compose.ui.unit.dp');
    const size = (key: string): number => parseFloat(a[`android:${key}`] ?? '');
    const builderArgs = [
        `name = ${kotlinString(name)}`,
        `defaultWidth = ${size('width')}.dp`,
        `defaultHeight = ${size('height')}.dp`,
        `viewportWidth = ${float(num(a, 'viewportWidth', NaN))}`,
        `viewportHeight = ${float(num(a, 'viewportHeight', NaN))}`,
    ];
    if (a['android:tint'] !== undefined) builderArgs.push(`tintColor = ${color(a['android:tint'], ctx)}`);
    if (a['android:autoMirrored'] === 'true') builderArgs.push('autoMirror = true');
    const body = indent(childrenCalls(vector.children, ctx).code, STEP + STEP);
    if (ctx.overlap)
        warn({
            code: 'opacity-approximated',
            message: `The root opacity (${ctx.alpha}) has no ImageVector equivalent: folded into the alpha of every fill and stroke; overlapping ones render darker.`,
            node: 'svg',
        });

    const imports = [...ctx.imports].sort().map((i) => `import ${i}\n`);
    const kotlin =
        (pkg === undefined ? '' : `package ${pkg}\n\n`) +
        `${imports.join('')}\n` +
        `val ${name}: ImageVector by lazy {\n` +
        `${STEP}ImageVector.Builder(\n${builderArgs.map((arg) => `${STEP}${STEP}${arg},\n`).join('')}${STEP}).apply {\n` +
        `${body}${body ? '\n' : ''}` +
        `${STEP}}.build()\n` +
        `}\n` +
        ctx.parts.map((part) => `\n${part}\n`).join('');
    return { kotlin, name, warnings };
}
