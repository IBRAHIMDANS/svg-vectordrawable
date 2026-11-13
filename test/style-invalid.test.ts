import { describe, expect, it } from 'vitest';
import { convert, ConversionError, type Warning } from '../src/index.js';
import type { XastElement } from '../src/ast.js';
import { parseSvg } from '../src/normalize.js';
import { cascadedStyle, isValidPropertyValue, parseStyle, presentation, styleDeclarations } from '../src/style.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;

/** The error `strict: 'lossy'` stops on, or null when the conversion succeeds. */
function strictError(input: string, optimize: boolean): Warning | null {
    try {
        convert(input, { strict: 'lossy', optimize });
        return null;
    } catch (err) {
        if (err instanceof ConversionError) return err.warning;
        throw err;
    }
}

/** A square with a same-winding hole: `nonzero` fills the hole, `evenodd` leaves it empty. */
const HOLE = 'M2 2h20v20H2z M7 7h10v10H7z';
/** Keeps the canvas inked when the element under test is hidden. */
const VISIBLE = '<rect width="24" height="4" fill="#00f"/>';

/**
 * Each case: a source whose inline `style` holds an invalid (or `!important`) declaration, and the
 * same drawing with the value a browser applies written by hand (Chrome / Firefox behaviour).
 */
const CASES: { name: string; source: string; reference: string }[] = [
    {
        name: 'fill-rule: an invalid declaration keeps the previous valid one',
        source: `<path d="${HOLE}" style="fill-rule:evenodd;fill-rule:bogus"/>`,
        reference: `<path d="${HOLE}" fill-rule="evenodd"/>`,
    },
    {
        name: 'display: an invalid declaration keeps the previous valid one',
        source: `${VISIBLE}<rect y="8" width="24" height="16" fill="#f00" style="display:none;display:bogus"/>`,
        reference: VISIBLE,
    },
    {
        name: 'display: an invalid declaration lets the attribute apply',
        source: `${VISIBLE}<rect y="8" width="24" height="16" fill="#f00" display="none" style="display:bogus"/>`,
        reference: VISIBLE,
    },
    {
        name: 'fill-opacity: an invalid declaration keeps the previous valid one',
        source: '<rect width="24" height="24" fill="#f00" style="fill-opacity:.5;fill-opacity:abc"/>',
        reference: '<rect width="24" height="24" fill="#f00" fill-opacity="0.5"/>',
    },
    {
        name: 'fill-opacity: an invalid declaration lets the attribute apply',
        source: '<rect width="24" height="24" fill="#f00" fill-opacity="0.5" style="fill-opacity:abc"/>',
        reference: '<rect width="24" height="24" fill="#f00" fill-opacity="0.5"/>',
    },
    {
        name: 'stroke-linecap: an invalid declaration keeps the previous valid one',
        source: '<line x1="6" y1="12" x2="18" y2="12" stroke="#000" stroke-width="6" style="stroke-linecap:round;stroke-linecap:zzz"/>',
        reference: '<line x1="6" y1="12" x2="18" y2="12" stroke="#000" stroke-width="6" stroke-linecap="round"/>',
    },
    {
        name: 'fill: an invalid declaration keeps the previous valid one',
        source: '<rect width="24" height="24" fill="#00f" style="fill:#f00;fill:bogus"/>',
        reference: '<rect width="24" height="24" fill="#f00"/>',
    },
    {
        name: 'stroke-width: an invalid declaration keeps the previous valid one',
        source: '<line x1="2" y1="12" x2="22" y2="12" stroke="#000" style="stroke-width:6;stroke-width:foo"/>',
        reference: '<line x1="2" y1="12" x2="22" y2="12" stroke="#000" stroke-width="6"/>',
    },
    {
        name: 'stroke-width: an invalid declaration lets the inherited value apply',
        source: '<g stroke-width="6" stroke="#000"><line x1="2" y1="12" x2="22" y2="12" style="stroke-width:foo"/><line x1="2" y1="4" x2="22" y2="4"/></g>',
        reference:
            '<g stroke-width="6" stroke="#000"><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="4" x2="22" y2="4"/></g>',
    },
    {
        name: 'stroke-width: a negative declaration lets the inherited value apply',
        source: '<g stroke-width="6" stroke="#000"><line x1="2" y1="12" x2="22" y2="12" style="stroke-width:-3"/><line x1="2" y1="4" x2="22" y2="4"/></g>',
        reference:
            '<g stroke-width="6" stroke="#000"><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="4" x2="22" y2="4"/></g>',
    },
    {
        name: '!important: the marker is not part of the value',
        source: '<rect width="24" height="24" style="fill:#f00 !important"/>',
        reference: '<rect width="24" height="24" fill="#f00"/>',
    },
    {
        name: '!important: the important declaration wins over a later normal one (fill)',
        source: '<rect width="24" height="24" style="fill:#f00 !important; fill:#00f"/>',
        reference: '<rect width="24" height="24" fill="#f00"/>',
    },
    {
        name: '!important: the important declaration wins over a later normal one (stroke-width)',
        source: '<line x1="2" y1="12" x2="22" y2="12" stroke="#000" style="stroke-width:6 !important; stroke-width:1"/>',
        reference: '<line x1="2" y1="12" x2="22" y2="12" stroke="#000" stroke-width="6"/>',
    },
    {
        name: '!important: the important declaration wins over a later normal one (rx)',
        source: '<rect width="24" height="24" style="rx:8 !important; rx:0"/>',
        reference: '<rect width="24" height="24" rx="8"/>',
    },
    {
        name: '!important: a later important declaration wins over an earlier one',
        source: '<rect width="24" height="24" style="fill:#00f !important; fill:#f00 ! IMPORTANT"/>',
        reference: '<rect width="24" height="24" fill="#f00"/>',
    },
];

describe.each([true, false])(
    'invalid inline style declarations are ignored, as CSS does (optimize: %s)',
    (optimize) => {
        const rendersLikeReference = ({ source, reference }: { source: string; reference: string }): void => {
            const { xml, warnings } = convert(svg(source), { optimize });
            expect(warnings).toEqual([]);
            const result = compareSvgs(svg(reference), vdToSvg(xml));
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            expect(strictError(svg(source), optimize)).toBeNull();
        };
        it.each(CASES)('$name', rendersLikeReference);

        it('an important unresolvable length still wins, and is reported', () => {
            const source = svg('<rect width="24" height="24" style="rx:1ex !important; rx:5"/>');
            const { warnings } = convert(source, { optimize });
            expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('1ex')]);
            expect(strictError(source, optimize)).not.toBeNull();
        });

        it('an unparseable but valid paint (env()) is still reported, not silently dropped', () => {
            const source = svg('<rect width="24" height="24" fill="#00f" style="fill:#f00;fill:env(--x)"/>');
            expect(convert(source, { optimize }).warnings.map((w) => w.code)).toEqual(['unsupported-paint']);
        });
    },
);

describe('optimize: true resolves each inline style before svgo merges repeated declarations', () => {
    // svgo's minifyStyles keeps the last of repeated declarations, even invalid: `cascadedStyle` runs first.
    const source = svg(`<path d="${HOLE}" style="fill-rule:evenodd;fill-rule:bogus"/>`);
    const reference = svg(`<path d="${HOLE}" fill-rule="evenodd"/>`);

    it.each([
        ['the default configuration', undefined],
        ['a custom svgoConfig', { plugins: ['preset-default' as const] }],
        ['a custom svgoConfig with minifyStyles only', { plugins: ['minifyStyles' as const] }],
    ])('with %s', (_, svgoConfig) => {
        const { xml, warnings } = convert(source, { optimize: true, svgoConfig });
        expect(warnings).toEqual([]);
        expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });

    it('removes a style left with no valid declaration, rather than writing style=""', () => {
        const root = parseSvg(svg('<rect width="24" height="24" style="fill-opacity:abc;display:bogus"/>'), true, {
            plugins: [],
        });
        const rect = (root.children[0] as XastElement).children!.find((c) => c.type === 'element') as XastElement;
        expect(rect.attributes).toEqual({ width: '24', height: '24' });
    });
});

describe('parseStyle', () => {
    it('keeps the last valid declaration of each property', () => {
        expect(parseStyle('fill-rule:evenodd;fill-rule:bogus;stroke-linecap:round;stroke-linecap:zzz')).toEqual({
            'fill-rule': 'evenodd',
            'stroke-linecap': 'round',
        });
        expect(parseStyle('display:bogus')).toEqual({});
        expect(parseStyle('fill-opacity:abc;opacity:50%')).toEqual({ opacity: '50%' });
    });

    it('keeps unknown properties and substitution functions as written', () => {
        expect(parseStyle('foo:bar;mask:url(#m);fill-rule:var(--r)')).toEqual({
            foo: 'bar',
            mask: 'url(#m)',
            'fill-rule': 'var(--r)',
        });
    });

    it('strips !important and lets the important declaration win', () => {
        expect(parseStyle('fill:red !important;fill:blue')).toEqual({ fill: 'red' });
        expect(parseStyle('fill:red!important;fill:blue !important')).toEqual({ fill: 'blue' });
        // An invalid important declaration is ignored like any other.
        expect(parseStyle('fill-rule:evenodd;fill-rule:bogus !important')).toEqual({ 'fill-rule': 'evenodd' });
    });

    it('styleDeclarations flags important declarations and strips the marker', () => {
        expect(styleDeclarations('rx: 1ex ! important; rx:5')).toEqual([
            ['rx', '1ex', true],
            ['rx', '5', false],
        ]);
    });

    it('cascadedStyle keeps one applying declaration per property, or the input when nothing is dropped', () => {
        expect(cascadedStyle('fill-rule:evenodd;fill-rule:bogus;fill:red !important;fill:blue;foo:bar')).toBe(
            'fill-rule:evenodd;fill:red!important;foo:bar',
        );
        expect(cascadedStyle('display:bogus')).toBe('');
        expect(cascadedStyle(' fill : red ; stroke:blue')).toBe(' fill : red ; stroke:blue');
    });

    it('presentation falls back to the attribute when the style has no valid declaration', () => {
        const el = { type: 'element' as const, name: 'rect', attributes: { display: 'none', style: 'display:bogus' } };
        expect(presentation(el, 'display')).toBe('none');
    });
});

describe('isValidPropertyValue', () => {
    it('accepts the CSS-wide keywords and substitution functions for every property', () => {
        for (const v of ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'var(--x)', 'env(x, 1)'])
            for (const p of ['display', 'fill-opacity', 'stroke-width', 'fill', 'stroke-linejoin'])
                expect(isValidPropertyValue(p, v), `${p}: ${v}`).toBe(true);
    });

    it('accepts any value for a property it does not know', () => {
        expect(isValidPropertyValue('foo', 'bar')).toBe(true);
        expect(isValidPropertyValue('clip-path', 'circle(50%)')).toBe(true);
    });

    it.each([
        ['display', ['none', 'inline', 'block', 'BLOCK', 'inline flow-root', 'contents'], ['bogus', 'none block', '']],
        ['visibility', ['visible', 'hidden', 'collapse'], ['bogus', 'none']],
        ['fill-rule', ['nonzero', 'EvenOdd'], ['bogus', 'even-odd']],
        ['clip-rule', ['nonzero', 'evenodd'], ['bogus']],
        ['stroke-linecap', ['butt', 'round', 'square'], ['zzz', 'miter']],
        ['stroke-linejoin', ['miter', 'miter-clip', 'round', 'bevel', 'arcs'], ['butt']],
        ['fill-opacity', ['0.5', '.5', '50%', '2', '-1', '1e-1'], ['abc', '0.5px', '50 %', '']],
        ['opacity', ['0'], ['none']],
        ['stroke-opacity', ['1'], ['x']],
        ['stop-opacity', ['1'], ['x']],
        ['stroke-miterlimit', ['4', '0.5'], ['-1', '4px', 'abc']],
        ['stroke-width', ['1', '2px', '1.5em', '10%', '1ex', '2vw', 'calc(1px + 2px)', '0'], ['foo', '-3', '1foo', '']],
        ['stroke-dashoffset', ['-3', '2px', '10%'], ['foo']],
        ['stroke-dasharray', ['none', '1 2', '1,2', '1px, 2%', '3'], ['-1 2', 'foo', '1,,2']],
        ['color', ['red', '#f00', 'currentColor', 'rgb(1 2 3)'], ['bogus', '#12', 'red blue']],
        ['fill', ['none', 'red', 'url(#g)', 'url(#g) red', 'context-fill', 'color-mix(in srgb, red, blue)'], ['bogus']],
        ['stroke', ['transparent', 'currentcolor'], ['#gggggg']],
        ['stop-color', ['oklch(0.6 0.1 170)'], ['bogus']],
        ['paint-order', ['normal', 'stroke', 'markers fill', 'stroke fill markers'], ['stroke stroke', 'bogus']],
        ['overflow', ['visible', 'hidden', 'auto', 'scroll', 'clip', 'hidden visible'], ['bogus']],
        ['mask-type', ['luminance', 'alpha'], ['bogus']],
        ['color-interpolation', ['auto', 'sRGB', 'linearRGB'], ['bogus']],
        ['vector-effect', ['none', 'non-scaling-stroke'], ['bogus']],
    ])('%s', (property, valid, invalid) => {
        for (const v of valid) expect(isValidPropertyValue(property, v), `${property}: ${v}`).toBe(true);
        for (const v of invalid) expect(isValidPropertyValue(property, v), `${property}: ${v}`).toBe(false);
    });
});

/**
 * T-179: a declaration that is not `<identifier>: value` (no colon, a name like `1x` or `a<b`) is
 * invalid CSS, which a browser ignores. svgo's minifyStyles (csso, css-tree 2.2.1) used to crash on
 * it, reported as "Invalid SVG" with `optimize: true` only.
 */
describe('declarations that are not identifier: value (T-179)', () => {
    it.each([
        'fill:red; stroke',
        'fill:red; stroke-width 2',
        'fill: red; 1x: 2',
        'a&lt;b:c;fill:red',
        '&lt;/g&gt;stroke:#0f0;fill:red',
        'fill:red;-:1',
    ])('%s: ignored, the rest applies, in both modes', (style) => {
        for (const optimize of [true, false]) {
            const { xml } = convert(svg(`<rect width="10" height="10" style="${style}"/>`), { optimize });
            expect(xml, `optimize: ${optimize}`).toContain('android:fillColor="#FFFF0000"');
            expect(xml).not.toContain('strokeColor');
        }
    });

    it('cascadedStyle drops them, and keeps names that are identifiers', () => {
        expect(cascadedStyle('fill:red; stroke')).toBe('fill:red');
        expect(cascadedStyle('a<b:c;fill:red')).toBe('fill:red');
        expect(cascadedStyle('fill:red;;')).toBe('fill:red;;');
        expect(cascadedStyle('fill:red;--brand:blue;-webkit-x:1;é:1')).toBe('fill:red;--brand:blue;-webkit-x:1;é:1');
        expect(cascadedStyle('/*c*/fill:red')).toBe('/*c*/fill:red');
    });
});
