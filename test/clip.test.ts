import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
const CLIP = '<clipPath id="c"><rect x="4" y="4" width="16" height="16"/></clipPath>';
const CIRCLE = '<circle cx="12" cy="12" r="11" fill="#E53935"/>';
const MODES = [true, false] as const;

const codes = (doc: string, optimize: boolean): string[] => convert(doc, { optimize }).warnings.map((w) => w.code);
const clipCount = (xml: string): number => xml.match(/<clip-path /g)?.length ?? 0;

/** The VectorDrawable renders like `reference` (the source unless given). */
function expectRendersLike(doc: string, optimize: boolean, reference = doc): void {
    const result = compareSvgs(reference, vdToSvg(convert(doc, { optimize }).xml));
    expect(result.sizeMismatch).toBeNull();
    expect(result.inked).toBeGreaterThan(0);
    expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
}

// Minimal reproduction of Ashung/svg2vectordrawable#51 (Illustrator export, clip-path set by a CSS class).
const ISSUE_51 = `<?xml version="1.0" encoding="utf-8"?>
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 24 24" xml:space="preserve">
<style type="text/css">
	.st0{fill:#E53935;}
	.st1{clip-path:url(#SVGID_2_);}
</style>
<defs>
	<rect id="SVGID_1_" x="4" y="4" width="16" height="16"/>
</defs>
<clipPath id="SVGID_2_">
	<use xlink:href="#SVGID_1_" style="overflow:visible;"/>
</clipPath>
<g class="st1">
	<circle class="st0" cx="12" cy="12" r="11"/>
</g>
</svg>`;

describe('clip-path declared in CSS (issue #51)', () => {
    it('keeps the clip of the issue SVG (optimize: true inlines the <style> rule)', () => {
        const { xml, warnings } = convert(ISSUE_51, { optimize: true, strict: true });
        expect(warnings).toEqual([]);
        expect(clipCount(xml)).toBe(1);
        expectRendersLike(ISSUE_51, true);
    });

    it('reports the un-inlined <style> with optimize: false instead of dropping it silently', () => {
        expect(codes(ISSUE_51, false)).toContain('unsupported-style');
        // What svgo makes of it: the same document with inline styles renders like the source.
        const inlined = ISSUE_51.replace(/<style[\s\S]*?<\/style>/, '')
            .replace('class="st1"', 'style="clip-path:url(#SVGID_2_)"')
            .replace('class="st0"', 'style="fill:#E53935"');
        for (const optimize of MODES) expectRendersLike(inlined, optimize, ISSUE_51);
    });

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            it('reads style="clip-path:url(#c)" on a shape', () => {
                const doc = svg(`${CLIP}<circle cx="12" cy="12" r="11" fill="#E53935" style="clip-path:url(#c)"/>`);
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize);
            });

            it('reads style="clip-path:url(#c)" on a group, without inheriting it (one clip)', () => {
                const doc = svg(
                    `${CLIP}<g style="clip-path:url(#c)">${CIRCLE}<rect x="0" y="0" width="6" height="6"/></g>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize);
            });

            it('accepts a quoted url in style', () => {
                const doc = svg(`${CLIP}<g style="clip-path: url('#c')">${CIRCLE}</g>`);
                expect(clipCount(convert(doc, { optimize }).xml)).toBe(1);
                // resvg (the reference renderer) ignores the quoted form: compare with the bare url.
                expectRendersLike(doc, optimize, svg(`${CLIP}<g clip-path="url(#c)">${CIRCLE}</g>`));
            });

            it('gives the style declaration precedence over the attribute', () => {
                const other = '<clipPath id="d"><rect x="0" y="0" width="2" height="2"/></clipPath>';
                const doc = svg(`${CLIP}${other}<g clip-path="url(#d)" style="clip-path:url(#c)">${CIRCLE}</g>`);
                expectRendersLike(doc, optimize, svg(`${CLIP}<g clip-path="url(#c)">${CIRCLE}</g>`));

                const none = svg(`${CLIP}<g clip-path="url(#c)" style="clip-path:none">${CIRCLE}</g>`);
                const { xml, warnings } = convert(none, { optimize });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(0);
            });

            it('reports an unknown id in style as missing-clip-path (rejected in strict)', () => {
                const doc = svg(`<g style="clip-path:url(#nope)">${CIRCLE}</g>`);
                expect(codes(doc, optimize)).toContain('missing-clip-path');
                expect(() => convert(doc, { optimize, strict: true })).toThrow(/clip-path/);
            });
        });
    }

    it('applies a <style> rule (optimize: true)', () => {
        const doc = svg(`<style>.k{clip-path:url(#c)}</style>${CLIP}<g class="k">${CIRCLE}</g>`);
        const { xml, warnings } = convert(doc, { optimize: true });
        expect(warnings).toEqual([]);
        expect(clipCount(xml)).toBe(1);
        expectRendersLike(doc, true);
    });

    it('reports a <style> rule pointing to an unknown id (optimize: true)', () => {
        const doc = svg(`<style>.k{clip-path:url(#nope)}</style><g class="k">${CIRCLE}</g>`);
        expect(codes(doc, true)).toContain('missing-clip-path');
    });
});

describe('non-rendering children of a <clipPath> (TASK-069)', () => {
    const DOC = svg(
        '<clipPath id="c"><title>Clip</title><desc>Square</desc><script>void 0</script>' +
            '<rect x="4" y="4" width="16" height="16"/></clipPath>' +
            `<g clip-path="url(#c)">${CIRCLE}</g>`,
    );
    for (const optimize of MODES) {
        it(`skips <title>/<desc>/<script> and keeps the clip (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(DOC, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(clipCount(xml)).toBe(1);
            expectRendersLike(DOC, optimize, svg(`<g clip-path="url(#c)">${CIRCLE}</g>${CLIP}`));
        });
    }
});

describe('clip-path values other than url(#id) (TASK-073)', () => {
    // CSS basic shapes need the element's reference box (fill-box: its bbox), which the clip
    // resolver does not measure: they are reported, like an external reference, never dropped silently.
    const UNSUPPORTED = [
        'inset(10%)',
        'circle(5px at 12px 12px)',
        'ellipse(50% 25%) fill-box',
        'polygon(0 0, 24px 0, 0 24px)',
        "path('M0 0H24V24Z')",
        'fill-box',
        'url(other.svg#c)',
        'url(https://example.com/clips.svg#c)',
    ];
    const ON_CIRCLE = (decl: string): string => svg(`<circle cx="12" cy="12" r="11" fill="#E53935" ${decl}/>`);

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const value of UNSUPPORTED) {
                for (const decl of [`clip-path="${value}"`, `style="clip-path:${value}"`]) {
                    it(`reports ${decl} as unsupported-clip-path (rejected in strict)`, () => {
                        const doc = ON_CIRCLE(decl);
                        const { xml, warnings } = convert(doc, { optimize });
                        expect(warnings.map((w) => w.code)).toEqual(['unsupported-clip-path']);
                        // svgo may requote the value: check its head only.
                        expect(warnings[0]!.message).toContain(value.slice(0, 5));
                        expect(clipCount(xml)).toBe(0);
                        expect(() => convert(doc, { optimize, strict: true })).toThrow(/clip-path/);
                    });
                }
            }

            it('says why an external url is ignored', () => {
                const [w] = convert(ON_CIRCLE('clip-path="url(other.svg#c)"'), { optimize }).warnings;
                expect(w!.message).toMatch(/external/);
            });

            it('reports a basic shape on a group once, and renders the content unclipped', () => {
                const doc = svg(`<g clip-path="circle(50%)">${CIRCLE}<rect width="6" height="6"/></g>`);
                expect(codes(doc, optimize)).toEqual(['unsupported-clip-path']);
                expectRendersLike(doc, optimize, svg(`<g>${CIRCLE}<rect width="6" height="6"/></g>`));
            });

            for (const value of ['none', 'None', 'initial', 'unset']) {
                it(`accepts clip-path="${value}" silently (no clip)`, () => {
                    const { xml, warnings } = convert(ON_CIRCLE(`clip-path="${value}"`), { optimize });
                    expect(warnings).toEqual([]);
                    expect(clipCount(xml)).toBe(0);
                });
            }
        });
    }
});
