import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';

const MODES = [true, false] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (inner: string): string =>
    `<svg xmlns="${SVG_NS}" width="24" height="24" viewBox="0 0 24 24">${inner}</svg>`;
const codes = (doc: string, optimize: boolean): string[] => convert(doc, { optimize }).warnings.map((w) => w.code);
const pathCount = (xml: string): number => xml.match(/<path\b/g)?.length ?? 0;

/** A drawable child covering the whole canvas: it overlaps any sibling. */
const RECT = '<rect width="24" height="24" fill="#008000"/>';
const half = (opacity: string, inner: string): string => svg(`<g opacity="${opacity}">${RECT}${inner}</g>`);

describe('group opacity: children that are not rendered never count as overlapping', () => {
    const notRendered: [string, string][] = [
        ['an element outside the SVG namespace', '<rect xmlns="http://example.org/ns" width="24" height="24"/>'],
        ['a subtree outside the SVG namespace', '<g xmlns="http://example.org/ns"><rect width="24" height="24"/></g>'],
        ['an empty systemLanguage', '<rect systemLanguage="" width="24" height="24"/>'],
        [
            'an unsupported requiredExtensions',
            '<rect requiredExtensions="http://example.org/ext" width="24" height="24"/>',
        ],
        ['a group failing its conditions', '<g requiredExtensions=""><rect width="24" height="24"/></g>'],
        ['a nested <svg> failing its conditions', '<svg systemLanguage=""><rect width="24" height="24"/></svg>'],
        ['display: none', '<rect display="none" width="24" height="24"/>'],
    ];

    for (const optimize of MODES)
        it.each(notRendered)(`%s (optimize: ${optimize})`, (_, child) => {
            const { xml, warnings } = convert(half('0.5', child), { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(pathCount(xml)).toBe(1);
        });
});

describe('group opacity: a real overlap is still reported', () => {
    it.each(MODES)('two overlapping rendered children (optimize: %s)', (optimize) => {
        expect(codes(half('0.5', '<rect x="4" y="4" width="8" height="8" fill="#ff0000"/>'), optimize)).toEqual([
            'opacity-approximated',
        ]);
    });

    it.each(MODES)('next to a non-rendered child (optimize: %s)', (optimize) => {
        const doc = half(
            '0.5',
            '<rect systemLanguage="" width="24" height="24"/><circle cx="12" cy="12" r="4" fill="#ff0000"/>',
        );
        expect(codes(doc, optimize)).toEqual(['opacity-approximated']);
    });

    it.each(MODES)('an opaque group is never checked (optimize: %s)', (optimize) => {
        expect(codes(half('1', '<rect x="4" y="4" width="8" height="8" fill="#ff0000"/>'), optimize)).toEqual([]);
    });
});

describe('group opacity: a fill or stroke that paints nothing never counts as overlapping (T-160)', () => {
    const PATTERN = '<defs><pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern></defs>';
    const EMPTY = '<defs><linearGradient id="lg"/></defs>';
    const GRADIENT =
        '<defs><linearGradient id="lg"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>';
    const box = (attrs: string): string => `<rect width="12" height="12" ${attrs}/>`;
    // [label, child, warnings left once the overlap check ignores the unpainted child]
    const unpainted: [string, string, string[]][] = [
        ['a paint server in another document, no fallback', box('fill="url(other.svg#g)"'), ['unsupported-paint']],
        ['a <pattern> fill, no fallback', PATTERN + box('fill="url(#p)"'), ['unsupported-paint']],
        ['a gradient without stops', EMPTY + box('fill="url(#lg)"'), ['missing-gradient']],
        ['a gradient without stops, over a fallback color', EMPTY + box('fill="url(#lg) red"'), ['missing-gradient']],
        ['an unknown paint server, no fallback', box('fill="url(#nope)"'), ['missing-gradient']],
        ['a transparent fill', box('fill="transparent"'), []],
        ['fill-opacity: 0', box('fill-opacity="0"'), []],
        ['a stroke without stops', EMPTY + box('fill="none" stroke="url(#lg)"'), ['missing-gradient']],
        ['an external stroke, no fallback', box('fill="none" stroke="url(other.svg#g)"'), ['unsupported-paint']],
        ['a zero-width stroke', box('fill="none" stroke="red" stroke-width="0"'), []],
    ];

    for (const optimize of MODES)
        it.each(unpainted)(`%s (optimize: ${optimize})`, (_, child, expected) => {
            const { xml, warnings } = convert(half('0.5', child), { optimize });
            expect(warnings.map((w) => w.code)).toEqual(expected);
            expect(pathCount(xml)).toBe(1);
        });

    const painted: [string, string][] = [
        ['a gradient with stops', GRADIENT + box('fill="url(#lg)"')],
        ['an external paint server with a fallback color', box('fill="url(other.svg#g) red"')],
        ['a <pattern> fill with a fallback color', PATTERN + box('fill="url(#p) red"')],
        ['a stroke only', box('fill="none" stroke="red"')],
    ];

    for (const optimize of MODES)
        it.each(painted)(`a real overlap still warns: %s (optimize: ${optimize})`, (_, child) => {
            expect(codes(half('0.5', child), optimize)).toContain('opacity-approximated');
        });
});

describe('group opacity: a stroke under a non-uniform scale grows by the largest stretch', () => {
    // Under scale(4 0.25) a 1-unit stroke on a vertical line paints 4 units wide: lines at x=1 and
    // x=1.8 paint [2,6] and [5.2,9.2] (overlap); at x=1 and x=4, [2,6] and [14,18] (disjoint).
    const stretched = (x2: number): string =>
        svg(
            `<g opacity="0.5"><g transform="scale(4 0.25)">` +
                `<path d="M1 0V40" stroke="#000" fill="none"/><path d="M${x2} 0V40" stroke="#f00" fill="none"/></g></g>`,
        );

    it.each(MODES)('strokes overlapping in the stretched axis warn (optimize: %s)', (optimize) => {
        expect(codes(stretched(1.8), optimize)).toEqual(['opacity-approximated']);
    });

    it.each(MODES)('clearly disjoint strokes do not warn (optimize: %s)', (optimize) => {
        expect(codes(stretched(4), optimize)).toEqual([]);
    });
});

describe('group opacity: the stroke margin covers miter tips and square caps (T-128)', () => {
    const CODES = (body: string, optimize: boolean): string[] => codes(svg(`<g opacity="0.5">${body}</g>`), optimize);
    // A sharp miter (half-width / sin(θ/2) ≈ 5.1) tips at x≈15.1, past the rect at x=13; the box widened
    // by half the stroke width stops at x=11.
    const chevron = (attrs = ''): string =>
        `<path d="M0 10L10 12L0 14" fill="none" stroke="#000" stroke-width="2" stroke-miterlimit="10"${attrs}/>` +
        '<rect x="13" y="11" width="7" height="2" fill="red"/>';
    // A square cap on a diagonal line reaches √2 × half-width past the endpoint (x≈11.41 > 11.2).
    const diagonal = (cap: string): string =>
        `<path d="M0 0L10 10" fill="none" stroke="#000" stroke-width="2" stroke-linecap="${cap}"/>` +
        '<rect x="11.2" y="9" width="2" height="2" fill="red"/>';

    it.each(MODES)('a sharp miter tip reaching a sibling warns (optimize: %s)', (optimize) => {
        expect(CODES(chevron(), optimize)).toEqual(['opacity-approximated']);
        expect(CODES(chevron(' stroke-linejoin="miter-clip"'), optimize)).toContain('opacity-approximated');
    });

    it.each(MODES)('a round or bevel join does not reach it: no warning (optimize: %s)', (optimize) => {
        expect(CODES(chevron(' stroke-linejoin="round"'), optimize)).toEqual([]);
        expect(CODES(chevron(' stroke-linejoin="bevel"'), optimize)).toEqual([]);
    });

    it.each(MODES)('a square cap reaches √2 × half its width (optimize: %s)', (optimize) => {
        expect(CODES(diagonal('square'), optimize)).toEqual(['opacity-approximated']);
        expect(CODES(diagonal('butt'), optimize)).toEqual([]);
    });

    it.each(MODES)('clearly disjoint mitered strokes do not warn (optimize: %s)', (optimize) => {
        const apart = chevron().replace('x="13"', 'x="40"').replace('width="7"', 'width="2"');
        expect(CODES(apart, optimize)).toEqual([]);
    });
});

describe('root opacity: exactly android:alpha on the <vector>, never approximated', () => {
    const overlapping = `${RECT}<rect x="4" y="4" width="8" height="8" fill="#ff0000"/>`;
    const roots: [string, string][] = [
        ['a CSS opacity', 'style="opacity:.5"'],
        ['an opacity attribute', 'opacity="0.5"'],
    ];

    for (const optimize of MODES)
        it.each(roots)(`%s with overlapping children (optimize: ${optimize})`, (_, attr) => {
            const doc = `<svg xmlns="${SVG_NS}" width="24" height="24" viewBox="0 0 24 24" ${attr}>${overlapping}</svg>`;
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings.map((w) => w.code)).not.toContain('opacity-approximated');
            expect(xml).toMatch(/<vector\b[^>]*android:alpha="0\.5"/);
        });
});
