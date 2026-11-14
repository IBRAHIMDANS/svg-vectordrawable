import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConversionError, convert, vectorDrawableToSvg } from '../src/index.js';
import { validPathData } from '../src/pathData.js';
import { path, write } from './pathArbitraries.js';
import { propertyParams, propertyTimeout } from './property.js';

/**
 * Light fuzzing of `convert` (T-177, step 4): random but well-formed SVG documents (shapes, groups,
 * transforms, paints, gradients, clips, `<use>`), then the same documents corrupted. A conversion
 * either returns or throws a documented error; it never fails with an internal exception
 * (TypeError, RangeError…), and what it returns is a VectorDrawable the preview can read.
 */

/**
 * The errors `convert` throws besides ConversionError: XML that does not parse (`Invalid SVG:
 * <input>:line:col: …`, same message in both modes), an empty document, no `<svg>` root, and the
 * `<use>` expansion budget (`MAX_EXPANDED_NODES`, reached by nested or self-referencing `<use>`).
 * Anything else is an internal failure.
 */
const EXPANSION = /^<use> expansion exceeds \d+ elements/;
const DOCUMENTED_ERRORS = [
    /^Invalid SVG: <input>:\d+:\d+: /,
    /^Failed to parse SVG: empty document$/,
    /^No <svg> root element found$/,
    EXPANSION,
];

/** A conversion must not take longer than this on a document of a few dozen elements. */
const MAX_MS = 5000;

const num = fc.oneof(
    fc.integer({ min: -50, max: 100 }).map(String),
    fc.double({ min: -100, max: 200, noNaN: true }).map((v) => String(Math.round(v * 1000) / 1000)),
);
const length = fc.oneof(
    { weight: 12, arbitrary: num },
    { weight: 2, arbitrary: fc.tuple(num, fc.constantFrom('px', '%', 'em', 'pt', 'mm')).map(([n, u]) => n + u) },
    // `1e400` (Infinity) and `1e39` leave the float range: the shape draws nothing (T-178).
    { weight: 1, arbitrary: fc.constantFrom('', 'auto', 'x', '-0', '.5', '1e400', '1e39') },
);
const paint = fc.constantFrom(
    'none',
    '#f00',
    '#123456',
    '#12345678',
    'red',
    'transparent',
    'currentColor',
    'rgb(0 128 255 / 50%)',
    'hsl(120deg 50% 50%)',
    'url(#g1)',
    'url(#g2)',
    'url(#missing)',
    'url(#missing) blue',
    'context-fill',
    'inherit',
    'bogus',
);
const transform = fc.oneof(
    fc.constantFrom(
        '',
        'none',
        'translate(5)',
        'rotate(30 12 12)',
        'skewX(20)',
        'scale(-1 1)',
        'scale(0)',
        'matrix(1 0 0 1)',
    ),
    fc.tuple(num, num, num, num, num, num).map((m) => `matrix(${m.join(' ')})`),
    fc.tuple(num, num, num).map(([a, b, c]) => `translate(${a} ${b}) rotate(${c}) scale(${b === '0' ? 1 : b})`),
);
const opacity = fc.oneof(
    fc.double({ min: -0.5, max: 1.5, noNaN: true }).map((v) => v.toFixed(2)),
    fc.constantFrom('50%', ''),
);

/** Presentation attributes common to every element. */
const PRESENTATION: Record<string, fc.Arbitrary<string>> = {
    fill: paint,
    stroke: paint,
    'stroke-width': length,
    'stroke-dasharray': fc.constantFrom('4 2', '0', '1,2,3', 'none', '-1'),
    'stroke-linecap': fc.constantFrom('round', 'square', 'butt'),
    opacity,
    'fill-opacity': opacity,
    'fill-rule': fc.constantFrom('evenodd', 'nonzero'),
    transform,
    'clip-path': fc.constantFrom('url(#c1)', 'url(#missing)', 'circle(5px)', 'none'),
    style: fc.constantFrom(
        'fill:blue',
        'stroke:#0f0;stroke-width:2',
        'opacity:.5',
        'transform:rotate(10deg)',
        'display:none',
        // Invalid declarations a browser ignores; csso used to crash on them (T-179).
        'fill:red; stroke',
        'stroke-width 2;fill:blue',
    ),
    id: fc.constantFrom('a', 'b', 'shape'),
};

/** Up to three presentation attributes: more would hide most shapes (clipped, transparent, unfilled). */
const presentation: fc.Arbitrary<Record<string, string>> = fc
    .shuffledSubarray(Object.keys(PRESENTATION), { maxLength: 3 })
    .chain((keys) => fc.record(Object.fromEntries(keys.map((k) => [k, PRESENTATION[k]!]))));

const shape = fc.oneof(
    {
        weight: 3,
        arbitrary: fc
            .record({ x: length, y: length, width: length, height: length, rx: length })
            .map((a) => ({ tag: 'rect', attrs: a })),
    },
    {
        weight: 2,
        arbitrary: fc.record({ cx: length, cy: length, r: length }).map((a) => ({ tag: 'circle', attrs: a })),
    },
    {
        weight: 1,
        arbitrary: fc
            .record({ cx: length, cy: length, rx: length, ry: length })
            .map((a) => ({ tag: 'ellipse', attrs: a })),
    },
    {
        weight: 1,
        arbitrary: fc
            .record({ x1: length, y1: length, x2: length, y2: length })
            .map((a) => ({ tag: 'line', attrs: a })),
    },
    {
        weight: 1,
        arbitrary: fc
            .tuple(fc.constantFrom('polyline', 'polygon'), fc.array(num, { maxLength: 9 }))
            .map(([tag, pts]) => ({ tag, attrs: { points: pts.join(' ') } })),
    },
    {
        weight: 4,
        arbitrary: fc.tuple(path({ max: 100, min: 1e-3 }), fc.boolean()).map(([[commands, s], first]) => ({
            tag: 'path',
            attrs: { d: (first ? 'M1 1' : '') + write(commands, s) },
        })),
    },
    // `<use>` may point at a duplicated or missing id, on purpose (never at an ancestor: groups have no id).
    {
        weight: 1,
        arbitrary: fc.constantFrom('#a', '#b', '#shape', '#missing').map((href) => ({ tag: 'use', attrs: { href } })),
    },
);

interface Node {
    tag: string;
    attrs: Record<string, string>;
    children?: Node[];
}

const node: fc.Arbitrary<Node> = fc.letrec<{ node: Node; group: Node }>((tie) => ({
    node: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        fc.tuple(shape, presentation).map(([s, p]) => ({ tag: s.tag, attrs: { ...p, ...s.attrs } })),
        tie('group'),
    ),
    group: fc
        .tuple(presentation, fc.array(tie('node'), { maxLength: 4 }))
        // No id on a group: a `<use>` inside the group it points at is a cycle, expanded up to
        // MAX_EXPANDED_NODES (seconds per document, TODO.md « Plus tard »). Duplicated ids stay.
        .map(([{ id: _id, ...attrs }, children]) => ({ tag: 'g', attrs, children })),
})).node;

const DEFS =
    '<defs>' +
    '<linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f" stop-opacity=".5"/></linearGradient>' +
    '<radialGradient id="g2" gradientUnits="userSpaceOnUse" cx="12" cy="12" r="8" gradientTransform="skewX(10)"><stop offset=".2" stop-color="green"/><stop offset="1" stop-color="currentColor"/></radialGradient>' +
    '<clipPath id="c1"><rect x="2" y="2" width="20" height="20" rx="4"/></clipPath>' +
    '</defs>';

const escape = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function serialize(n: Node): string {
    const attrs = Object.entries(n.attrs)
        .map(([k, v]) => ` ${k}="${escape(v)}"`)
        .join('');
    const children = n.children?.map(serialize).join('') ?? '';
    return children ? `<${n.tag}${attrs}>${children}</${n.tag}>` : `<${n.tag}${attrs}/>`;
}

const document = fc
    .tuple(
        fc.array(node, { minLength: 1, maxLength: 5 }),
        fc.constantFrom('0 0 24 24', '-12 -12 24 24', '0 0 100 50', '0 0 0 0'),
    )
    .map(
        ([nodes, viewBox]) =>
            `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="${viewBox}">${DEFS}${nodes.map(serialize).join('')}</svg>`,
    );

const options = fc.record({
    optimize: fc.boolean(),
    strict: fc.constantFrom<boolean | 'lossy'>(false, true, 'lossy'),
});

type Outcome = { xml: string } | { error: unknown };

/** Runs `convert` within the time limit; returns its XML or what it threw. */
function run(svg: string, opts: { optimize: boolean; strict: boolean | 'lossy' }): Outcome {
    const start = performance.now();
    try {
        return { xml: convert(svg, opts).xml };
    } catch (error) {
        return { error };
    } finally {
        expect(performance.now() - start, svg).toBeLessThan(MAX_MS);
    }
}

/** True for a ConversionError, or a plain Error whose message is one `convert` documents. */
function isDocumented(err: unknown, allowed = DOCUMENTED_ERRORS): boolean {
    if (err instanceof ConversionError) return true;
    return err instanceof Error && err.constructor === Error && allowed.some((re) => re.test(err.message));
}

// A conversion runs svgo: fewer draws than the pure-function suites, same seed handling, and
// about 20 ms per document allowed (a document converts in under 10 ms on average).
const params = { ...propertyParams, numRuns: Math.ceil((propertyParams.numRuns ?? 300) / 3) };

describe('convert (fuzz)', { timeout: Math.max(propertyTimeout, 60_000, params.numRuns! * 20) }, () => {
    it('a well-formed document converts, or is rejected under strict, or exceeds the <use> budget', () => {
        fc.assert(
            fc.property(document, options, (svg, opts) => {
                const outcome = run(svg, opts);
                if ('error' in outcome) {
                    const { error } = outcome;
                    const allowed =
                        error instanceof ConversionError ? opts.strict !== false : isDocumented(error, [EXPANSION]);
                    expect(allowed, `${String(error)}\n${svg}`).toBe(true);
                    return;
                }
                // What it returns is a VectorDrawable the preview reads, with valid path data.
                expect(() => vectorDrawableToSvg(outcome.xml), svg).not.toThrow();
                for (const [, d] of outcome.xml.matchAll(/android:pathData="([^"]*)"/g)) {
                    expect(validPathData(d!), svg).toBe(d);
                }
            }),
            params,
        );
    });

    it('a corrupted document converts or fails with a documented error, never an internal one', () => {
        const corruption = fc.record({
            at: fc.nat(),
            remove: fc.nat({ max: 12 }),
            insert: fc.constantFrom(
                '',
                '<',
                '>',
                '"',
                '/',
                '&',
                '&#0;',
                '<g>',
                '</g>',
                '<!--',
                ']]>',
                'xmlns:x="y"',
                ' d="',
                '\u0000',
            ),
        });
        fc.assert(
            fc.property(document, corruption, options, (svg, { at, remove, insert }, opts) => {
                const i = at % (svg.length + 1);
                const broken = svg.slice(0, i) + insert + svg.slice(i + remove);
                const outcome = run(broken, opts);
                if ('error' in outcome)
                    expect(isDocumented(outcome.error), `${String(outcome.error)}\n${broken}`).toBe(true);
            }),
            params,
        );
    });
});
