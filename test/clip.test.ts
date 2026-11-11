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

describe('masks with fill-rule="evenodd" content (TASK-079)', () => {
    const RING = 'M3 3h18v18H3zM8 8h8v8H8z';
    const SQUARE = '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>';
    const maskMessages = (doc: string, optimize: boolean): string[] =>
        convert(doc, { optimize })
            .warnings.filter((w) => w.message.includes('mask'))
            .map((w) => w.message);

    /** Converted to clips, without warning (also in strict), and renders like the source. */
    function expectClipped(doc: string): void {
        for (const optimize of MODES) {
            const { xml, warnings } = convert(doc, { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(xml).not.toContain('mask');
            expect(clipCount(xml)).toBeGreaterThan(0);
            expectRendersLike(doc, optimize);
        }
    }

    const CASES: Record<string, string> = {
        'a ring': `<mask id="m"><path d="${RING}" fill="#fff" fill-rule="evenodd"/></mask>${SQUARE}`,
        'fill-rule inherited from the mask': `<mask id="m" fill-rule="evenodd"><path d="${RING}" fill="#fff"/></mask>${SQUARE}`,
        'fill-rule set in style on a group': `<mask id="m"><g style="fill-rule:evenodd"><path d="${RING}" fill="#fff"/></g></mask>${SQUARE}`,
        'three nested levels': `<mask id="m"><path d="M1 1h22v22H1zM5 5h14v14H5zM9 9h6v6H9z" fill="#fff" fill-rule="evenodd"/></mask>${SQUARE}`,
        'a ring already wound for nonzero': `<mask id="m"><path d="M3 3h18v18H3zM8 8v8h8V8z" fill="#fff" fill-rule="evenodd"/></mask>${SQUARE}`,
        'a mirrored mask content': `<mask id="m"><g transform="matrix(-1 0 0 1 24 0)"><path d="M2 3h16v18H2zM6 8h6v8H6z" fill="#fff" fill-rule="evenodd"/></g></mask>${SQUARE}`,
        'an alpha mask (Figma export)':
            '<mask id="m" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="3" y="3" width="18" height="18">' +
            `<path d="${RING}" fill="#D9D9D9" fill-rule="evenodd"/></mask><g mask="url(#m)"><path d="M0 0h24v24H0z" fill="#123456"/></g>`,
        'a ring next to a nonzero shape':
            `<mask id="m"><path d="M1 1h10v10H1zM4 4h4v4H4z" fill="#fff" fill-rule="evenodd"/>` +
            `<rect x="13" y="13" width="9" height="9" fill="#fff"/></mask>${SQUARE}`,
        'objectBoundingBox content':
            '<mask id="m" maskContentUnits="objectBoundingBox"><path d="M.1 .1h.8v.8h-.8zM.3 .3h.4v.4h-.4z" fill="#fff" fill-rule="evenodd"/></mask>' +
            '<rect x="4" y="2" width="16" height="20" fill="#E53935" mask="url(#m)"/>',
    };
    for (const [name, inner] of Object.entries(CASES)) {
        it(`clips like the source: ${name}`, () => expectClipped(svg(inner)));
    }

    // Overlapping pieces are united: the rewritten evenodd piece is wound positively, and a nonzero
    // piece wound the other way is reversed instead of cancelling it in the overlap.
    for (const d of ['M10 10h12v12H10z', 'M10 10v12h12V10z']) {
        it(`unites an evenodd piece with an overlapping nonzero piece (${d})`, () =>
            expectClipped(
                svg(
                    `<mask id="m"><path d="${RING}" fill="#fff" fill-rule="evenodd"/><path d="${d}" fill="#fff"/></mask>${SQUARE}`,
                ),
            ));
    }

    it('keeps the warning when evenodd contours cross (no nonzero equivalent by orientation)', () => {
        const doc = svg(
            `<mask id="m"><path d="M2 2h12v12H2zM8 8h12v12H8z" fill="#fff" fill-rule="evenodd"/></mask>${SQUARE}`,
        );
        for (const optimize of MODES) {
            const messages = maskMessages(doc, optimize);
            expect(messages).toHaveLength(1);
            expect(messages[0]).toMatch(/evenodd.*crossing/);
            expect(clipCount(convert(doc, { optimize }).xml)).toBe(0);
        }
    });

    // Same structure as brave/leo `country-ke` (a Figma flag export, redrawn here): stripes under a
    // full-size mask, a shield whose content is masked by an evenodd path. The masks used to be
    // ignored (36 % of the pixels off on the real flag, 0.9 % with svg2vectordrawable 2.9.1).
    const FLAG =
        '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 18"><g clip-path="url(#a)">' +
        '<mask id="b" width="24" height="18" x="0" y="0" maskUnits="userSpaceOnUse" style="mask-type:luminance">' +
        '<path fill="#fff" d="M0 0h24v18H0z"/></mask><g mask="url(#b)">' +
        '<path fill="#272727" fill-rule="evenodd" d="M0 0v6h24V0z"/><path fill="#4e8b1d" fill-rule="evenodd" d="M0 12v6h24v-6z"/>' +
        '<path fill="#e31d1c" stroke="#f7fcff" stroke-width="2" d="M-1 5h26v8H-1z"/></g>' +
        '<path fill="#e31d1c" fill-rule="evenodd" d="M12 15c1 0 4-3 4-6s-3-6-4-6-4 3-4 6 3 6 4 6"/>' +
        '<mask id="c" width="8" height="12" x="8" y="3" maskUnits="userSpaceOnUse" style="mask-type:luminance">' +
        '<path fill="#fff" fill-rule="evenodd" d="M12 15c1 0 4-3 4-6s-3-6-4-6-4 3-4 6 3 6 4 6"/></mask>' +
        '<g mask="url(#c)"><path fill="#272727" d="M5 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10m14 0a5 5 0 1 0 0-10 5 5 0 0 0 0 10"/>' +
        '<path fill="#f7fcff" fill-rule="evenodd" d="M11.5 3h1v12h-1zM11 8.5h2v1h-2z"/></g></g>' +
        '<defs><clipPath id="a"><rect width="24" height="18" rx="2"/></clipPath></defs></svg>';

    for (const optimize of MODES) {
        it(`converts the masks of a Figma flag (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(FLAG, { optimize });
            expect(warnings).toEqual([]);
            expect(xml).not.toContain('mask');
            expectRendersLike(FLAG, optimize);
        });
    }
});

describe('masks with stroked content (TASK-090)', () => {
    // A Figma export (redrawn after daangn/icona `icon_scissors`): an alpha mask whose shape is filled
    // and stroked with the same color. A clip-path has no stroke outline: the stroke is ignored.
    // White rather than icona's purple: the test renderer (resvg) reads this mask as luminance.
    const SHAPE = 'M7 3l7 12-1 4-7-13c-.5-1-.2-2 .5-2.5z';
    const STROKE = ' stroke="#fff" stroke-width="0.9" stroke-linejoin="round"';
    const figma = (stroke: string): string =>
        svg(
            '<mask id="m" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="5" y="2" width="10" height="18">' +
                `<path d="${SHAPE}" fill="#fff"${stroke}/></mask>` +
                '<g mask="url(#m)"><path d="M0 0h24v24H0z" fill="#212124"/></g>',
        );
    const maskWarnings = (doc: string, optimize: boolean) =>
        convert(doc, { optimize }).warnings.filter((w) => w.message.includes('mask'));

    for (const optimize of MODES) {
        it(`clips with the filled shape and warns mask-approximated (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(figma(STROKE), { optimize });
            expect(warnings.map((w) => w.code)).toEqual(['mask-approximated']);
            expect(warnings[0]!.message).toMatch(/^mask "\w+": the stroke of its content is ignored/);
            expect(xml).not.toContain('mask');
            expect(clipCount(xml)).toBeGreaterThan(0);
            // Exactly the source without the stroke of the mask content.
            expectRendersLike(figma(STROKE), optimize, figma(''));
        });
    }

    it('drops a stroke-only shape and keeps the filled ones', () => {
        const doc = (strokeOnly: string): string =>
            svg(
                `<mask id="m"><rect x="2" y="2" width="9" height="9" fill="#fff"/>${strokeOnly}</mask>` +
                    '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>',
            );
        const withStroke = doc('<circle cx="17" cy="17" r="4" fill="none" stroke="#fff" stroke-width="2"/>');
        for (const optimize of MODES) {
            expect(convert(withStroke, { optimize }).warnings.map((w) => w.code)).toEqual(['mask-approximated']);
            expectRendersLike(withStroke, optimize, doc(''));
        }
    });

    it('warns once per mask, also when objectBoundingBox content is resolved per element', () => {
        const shared = svg(
            '<mask id="m"><rect x="4" y="4" width="16" height="16" fill="#fff" stroke="#fff"/></mask>' +
                '<path d="M0 0h12v12H0z" fill="#f00" mask="url(#m)"/><path d="M12 12h12v12H12z" fill="#00f" mask="url(#m)"/>',
        );
        const bbox = svg(
            '<mask id="m" maskContentUnits="objectBoundingBox"><rect width=".5" height=".5" fill="#fff" stroke="#fff" stroke-width=".05"/></mask>' +
                '<rect x="2" y="2" width="8" height="8" fill="#f00" mask="url(#m)"/><rect x="12" y="12" width="10" height="10" fill="#00f" mask="url(#m)"/>',
        );
        for (const doc of [shared, bbox])
            for (const optimize of MODES) {
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings.map((w) => w.code)).toEqual(['mask-approximated']);
                expect(clipCount(xml)).toBeGreaterThanOrEqual(2);
            }
    });

    it('refuses a mask that only paints strokes (nothing left to clip with)', () => {
        const doc = svg(
            '<mask id="m"><circle cx="12" cy="12" r="6" fill="none" stroke="#fff" stroke-width="3"/></mask>' +
                '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>',
        );
        for (const optimize of MODES) {
            const warnings = maskWarnings(doc, optimize);
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(warnings[0]!.message).toMatch(/only paints strokes/);
            expect(clipCount(convert(doc, { optimize }).xml)).toBe(0);
        }
    });

    it('still refuses a stroked shape whose fill is not clip-equivalent, without mask-approximated', () => {
        const doc = svg(
            '<mask id="m"><rect x="4" y="4" width="16" height="16" fill="#808080" stroke="#fff"/></mask>' +
                '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>',
        );
        for (const optimize of MODES) {
            const warnings = maskWarnings(doc, optimize);
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(warnings[0]!.message).toMatch(/not white/);
        }
    });
});
