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
