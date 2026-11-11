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
    // Values left out of the basic-shape conversion (TASK-077) are reported, like an external
    // reference, never dropped silently.
    const UNSUPPORTED = [
        "path('M0 0H24V24Z')",
        'fill-box',
        'url(other.svg#c)',
        'url(https://example.com/clips.svg#c)',
        'inset(10% round 2px)',
        'circle(5px) view-box',
        'circle(closest-corner)',
        'circle(at left 2px top)',
        'fill-box circle() stroke-box',
        'inset(60%)',
        'circle(-1px)',
        'polygon(0 0, 24px)',
        'xywh(0 0 10px 10px)',
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

            it('reports a basic shape on a stroked group once, and renders the content unclipped', () => {
                // Default reference box: stroke-box, larger than the geometry once a stroke is painted.
                const doc = svg(`<g clip-path="circle(50%)" stroke="#000">${CIRCLE}<rect width="6" height="6"/></g>`);
                expect(codes(doc, optimize)).toEqual(['unsupported-clip-path']);
                expectRendersLike(doc, optimize, svg(`<g stroke="#000">${CIRCLE}<rect width="6" height="6"/></g>`));
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

describe('CSS basic shapes in clip-path (TASK-077)', () => {
    // resvg 2.6 ignores basic shapes (it renders the element unclipped): every reference is the same
    // element clipped by the equivalent explicit <clipPath>, computed by hand from the reference box.
    // The element's bbox (fill-box) is 2,4 20×16: percentages of x and y differ.
    const RECT = 'x="2" y="4" width="20" height="16" fill="#E53935"';
    const shaped = (value: string, decl: 'attr' | 'style' = 'attr', extra = ''): string =>
        svg(`<rect ${RECT}${extra} ${decl === 'attr' ? `clip-path="${value}"` : `style="clip-path:${value}"`}/>`);
    const clipped = (clipContent: string, extra = ''): string =>
        svg(`<clipPath id="ref">${clipContent}</clipPath><rect ${RECT}${extra} clip-path="url(#ref)"/>`);

    const CASES: [string, string][] = [
        ['inset(10%)', '<rect x="4" y="5.6" width="16" height="12.8"/>'],
        ['inset(2px 4px)', '<rect x="6" y="6" width="12" height="12"/>'],
        ['inset(1px 2px 3px 4px)', '<rect x="6" y="5" width="14" height="12"/>'],
        ['inset(0 25% 50%)', '<rect x="7" y="4" width="10" height="8"/>'],
        // √((20² + 16²) / 2) = √328.
        ['circle(50%)', `<circle cx="12" cy="12" r="${Math.sqrt(328) / 2}"/>`],
        ['circle()', '<circle cx="12" cy="12" r="8"/>'],
        ['circle(closest-side at 25% 25%)', '<circle cx="7" cy="8" r="4"/>'],
        ['circle(farthest-side at left top)', '<circle cx="2" cy="4" r="20"/>'],
        ['circle(5px at 12px 4px)', '<circle cx="14" cy="8" r="5"/>'],
        ['circle(6px at bottom)', '<circle cx="12" cy="20" r="6"/>'],
        ['ellipse(50% 25%) fill-box', '<ellipse cx="12" cy="12" rx="10" ry="4"/>'],
        ['ellipse()', '<ellipse cx="12" cy="12" rx="10" ry="8"/>'],
        ['ellipse(closest-side farthest-side at 25% 75%)', '<ellipse cx="7" cy="16" rx="5" ry="12"/>'],
        ['polygon(0 0, 100% 0, 0 100%)', '<polygon points="2,4 22,4 2,20"/>'],
        ['polygon(nonzero, 50% 0, 100% 100%, 0 100%)', '<polygon points="12,4 22,20 2,20"/>'],
        ['polygon(evenodd, 2px 2px, 18px 2px, 18px 14px, 2px 14px)', '<polygon points="4,6 20,6 20,18 4,18"/>'],
        ['content-box inset(10%)', '<rect x="4" y="5.6" width="16" height="12.8"/>'],
        ['border-box circle()', '<circle cx="12" cy="12" r="8"/>'],
        ['circle() stroke-box', '<circle cx="12" cy="12" r="8"/>'],
        ['CIRCLE(50% AT 0 0)', `<circle cx="2" cy="4" r="${Math.sqrt(328) / 2}"/>`],
    ];

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const [value, clip] of CASES) {
                for (const decl of ['attr', 'style'] as const) {
                    it(`clips like the equivalent <clipPath>: ${value} (${decl})`, () => {
                        const doc = shaped(value, decl);
                        const { xml, warnings } = convert(doc, { optimize, strict: true });
                        expect(warnings).toEqual([]);
                        expect(clipCount(xml)).toBe(1);
                        expectRendersLike(doc, optimize, clipped(clip));
                    });
                }
            }

            it('lays a shape out in the bbox of a group (its content united, transforms included)', () => {
                const content =
                    '<rect x="2" y="2" width="8" height="8" fill="#1E88E5"/>' +
                    '<rect width="10" height="10" fill="#43A047" transform="translate(12 12)"/>';
                const doc = svg(`<g clip-path="circle(50%)">${content}</g>`);
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                // bbox 2,2 20×20: r = 50% of 20.
                const ref = svg(
                    `<clipPath id="ref"><circle cx="12" cy="12" r="10"/></clipPath><g clip-path="url(#ref)">${content}</g>`,
                );
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize, ref);
            });

            // With optimize: true, src/normalize.ts keeps svgo from baking the transform into the geometry
            // (it only did so for a url() clip-path), which would change the reference box.
            it("lays a shape out in the element's own user space (after its transform)", () => {
                const rotate = ' transform="rotate(30 12 12)"';
                const doc = shaped('inset(25%)', 'attr', rotate);
                expect(convert(doc, { optimize, strict: true }).warnings).toEqual([]);
                expectRendersLike(doc, optimize, clipped('<rect x="7" y="8" width="10" height="8"/>', rotate));
                const content = `<rect ${RECT}/><rect x="0" y="0" width="4" height="4"/>`;
                const group = svg(`<g transform="rotate(30 12 12)" clip-path="circle(40%)">${content}</g>`);
                expect(convert(group, { optimize, strict: true }).warnings).toEqual([]);
                // bbox 0,0 22×20: r = 40% of √((22² + 20²) / 2) = 0.4·√442.
                const ref = svg(
                    `<clipPath id="ref"><circle cx="11" cy="10" r="${0.4 * Math.sqrt(442)}"/></clipPath>` +
                        `<g transform="rotate(30 12 12)" clip-path="url(#ref)">${content}</g>`,
                );
                expectRendersLike(group, optimize, ref);
            });

            it('uses the geometry as stroke-box when nothing is stroked (stroke="none", stroke-width="0")', () => {
                for (const extra of [' stroke="none"', ' stroke="#000" stroke-width="0"']) {
                    const doc = shaped('circle()', 'attr', extra);
                    expect(convert(doc, { optimize, strict: true }).warnings).toEqual([]);
                    expectRendersLike(doc, optimize, clipped('<circle cx="12" cy="12" r="8"/>', extra));
                }
            });

            it('keeps fill-box on a stroked element (the stroke is clipped, not the box)', () => {
                const extra = ' stroke="#1E88E5" stroke-width="2"';
                const doc = shaped('inset(10%) fill-box', 'attr', extra);
                expect(convert(doc, { optimize, strict: true }).warnings).toEqual([]);
                expectRendersLike(doc, optimize, clipped('<rect x="4" y="5.6" width="16" height="12.8"/>', extra));
            });

            for (const value of [
                'inset(10%)',
                'border-box inset(10%)',
                'margin-box inset(10%)',
                'inset(10%) stroke-box',
            ]) {
                it(`reports the stroke-box of a stroked element: ${value}`, () => {
                    const doc = shaped(value, 'attr', ' stroke="#1E88E5" stroke-width="2"');
                    const { xml, warnings } = convert(doc, { optimize });
                    expect(warnings.map((w) => w.code)).toEqual(['unsupported-clip-path']);
                    expect(warnings[0]!.message).toMatch(/stroke bounding box/);
                    expect(clipCount(xml)).toBe(0);
                });
            }

            it('reports an evenodd polygon whose contour crosses itself (nonzero is used)', () => {
                // A pentagram: evenodd leaves its center out, nonzero fills it.
                const star = 'polygon(evenodd, 50% 0, 79% 90%, 2% 35%, 98% 35%, 21% 90%)';
                const { xml, warnings } = convert(shaped(star), { optimize });
                expect(warnings.map((w) => w.code)).toEqual(['unsupported-clip-path']);
                expect(warnings[0]!.message).toMatch(/polygon\(\).*crossing/);
                expect(clipCount(xml)).toBe(1);
            });

            it('reports a shape on an element whose bbox is unknown (a <switch>)', () => {
                const doc = svg(`<switch clip-path="circle()"><rect ${RECT}/></switch>`);
                expect(codes(doc, optimize)).toEqual(['unsupported-clip-path']);
            });
        });
    }
});

describe('non-rendered content in clip, mask and bbox walks (TASK-077)', () => {
    // Same filter as the renderer (isNotRendered): foreign elements and failing conditional processing
    // are skipped, without warning, by the <clipPath>, <mask> and bounding-box walks.
    const FOREIGN = '<h:rect xmlns:h="http://example.com/h" x="0" y="0" width="24" height="24"/>';
    const FAILING = '<rect requiredExtensions="" x="0" y="0" width="24" height="24"/>';
    const SMALL = '<rect x="4" y="4" width="8" height="8"/>';
    const BIG = '<rect x="0" y="0" width="24" height="24" fill="#E53935"';

    for (const optimize of MODES) {
        for (const [name, skipped] of [
            ['a foreign element', FOREIGN],
            ['requiredExtensions=""', FAILING],
        ] as const) {
            describe(`${name} (optimize: ${optimize})`, () => {
                it('is skipped inside a <clipPath>', () => {
                    const doc = svg(`<clipPath id="c">${skipped}${SMALL}</clipPath>${BIG} clip-path="url(#c)"/>`);
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(clipCount(xml)).toBe(1);
                    expectRendersLike(
                        doc,
                        optimize,
                        svg(`<clipPath id="c">${SMALL}</clipPath>${BIG} clip-path="url(#c)"/>`),
                    );
                });

                it('is skipped inside a <mask>', () => {
                    const white = SMALL.replace('/>', ' fill="#fff"/>');
                    const doc = svg(
                        `<mask id="m">${skipped.replace('/>', ' fill="#fff"/>')}${white}</mask>${BIG} mask="url(#m)"/>`,
                    );
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(xml).not.toContain('mask');
                    expectRendersLike(
                        doc,
                        optimize,
                        svg(`<clipPath id="c">${SMALL}</clipPath>${BIG} clip-path="url(#c)"/>`),
                    );
                });

                it('is left out of a group bbox (reference box of a basic shape)', () => {
                    const doc = svg(
                        `<g clip-path="inset(25%)">${skipped}<rect x="4" y="4" width="16" height="16" fill="#E53935"/></g>`,
                    );
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(clipCount(xml)).toBe(1);
                    expectRendersLike(doc, optimize, svg('<rect x="8" y="8" width="8" height="8" fill="#E53935"/>'));
                });
            });
        }
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
            '<mask id="m"><rect x="4" y="4" width="8" height="8" fill="#fff" stroke="#fff"/>' +
                '<rect x="12" y="12" width="8" height="8" fill="#808080" stroke="#fff"/></mask>' +
                '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>',
        );
        for (const optimize of MODES) {
            const warnings = maskWarnings(doc, optimize);
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(warnings[0]!.message).toMatch(/not uniform/);
        }
    });

    it.each([
        ['stroke-opacity="0"', 'stroke="#fff" stroke-width="3" stroke-opacity="0"'],
        ['stroke-width="0"', 'stroke="#fff" stroke-width="0"'],
        ['a transparent stroke color', 'stroke="transparent" stroke-width="3"'],
        ['an rgba stroke of alpha 0', 'stroke="rgba(255,255,255,0)" stroke-width="3"'],
    ])('does not warn mask-approximated for an invisible stroke (%s)', (_, stroke) => {
        const doc = svg(
            `<mask id="m"><rect x="4" y="4" width="16" height="16" fill="#fff" ${stroke}/></mask>` +
                '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>',
        );
        for (const optimize of MODES) {
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings).toEqual([]);
            expect(clipCount(xml)).toBe(1);
            expectRendersLike(doc, optimize);
        }
    });
});

describe('masks of uniform non-white luminance and nested masks (TASK-092)', () => {
    const FULL = '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>';
    const maskOf = (content: string, attrs = ''): string => `<mask id="m"${attrs}>${content}</mask>`;
    const fillAlphas = (xml: string): string[] => [...xml.matchAll(/android:fillAlpha="([^"]+)"/g)].map((m) => m[1]!);

    /** Converted without warning, clipped `clips` times, rendering like its source. */
    function expectExact(doc: string, clips = 1): string {
        let out = '';
        for (const optimize of MODES) {
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings).toEqual([]);
            expect(xml).not.toContain('mask');
            expect(clipCount(xml)).toBe(clips);
            expectRendersLike(doc, optimize);
            out = xml;
        }
        return out;
    }

    function expectRefused(doc: string, reason: RegExp): void {
        for (const optimize of MODES) {
            const { xml, warnings } = convert(doc, { optimize });
            const masks = warnings.filter((w) => w.message.includes('mask on'));
            expect(masks.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(masks[0]!.message).toMatch(reason);
            expect(clipCount(xml)).toBe(0);
        }
    }

    it.each([
        ['gray', '#808080', 0.502],
        ['pure red (0.2125)', '#f00', 0.2125],
        ['pure green (0.7154)', '#00ff00', 0.7154],
        ['Figma blue', '#2e42a5', 0.2701],
    ])('clips with the shape and fades by the luminance of a %s fill', (_, color, alpha) => {
        const xml = expectExact(svg(maskOf(`<rect x="4" y="4" width="16" height="16" fill="${color}"/>`) + FULL));
        expect(Number(fillAlphas(xml)[0])).toBeCloseTo(alpha, 2);
    });

    it.each([
        ['fill-opacity', '<rect x="4" y="4" width="16" height="16" fill="#fff" fill-opacity="0.5"/>'],
        ['an rgba gray', '<rect x="4" y="4" width="16" height="16" fill="rgba(128,128,128,0.5)"/>'],
        [
            'a group opacity over shapes that do not overlap',
            '<g opacity="0.5"><rect x="4" y="4" width="8" height="8" fill="#fff"/><rect x="12" y="12" width="8" height="8" fill="#fff"/></g>',
        ],
    ])('fades by luminance × alpha for translucent content (%s)', (_, content) => {
        expectExact(svg(maskOf(content) + FULL));
    });

    it('fades by the alpha of an alpha mask, whatever the color', () => {
        const content = '<rect x="4" y="4" width="16" height="16" fill="#123456" opacity="0.4"/>';
        expect(fillAlphas(expectExact(svg(maskOf(content, ' mask-type="alpha"') + FULL)))).toEqual(['0.4']);
    });

    it('multiplies the own opacity of the element, set as an attribute or in its style', () => {
        const content = maskOf('<rect x="4" y="4" width="16" height="16" fill="#808080"/>');
        for (const own of ['opacity="0.5"', 'style="opacity:0.5"'])
            expectExact(svg(`${content}<path d="M0 0h24v24H0z" fill="#E53935" ${own} mask="url(#m)"/>`));
    });

    it('fades the leaves of a masked group; warns opacity-approximated only when they overlap', () => {
        const content = maskOf('<rect x="2" y="2" width="20" height="20" fill="#808080"/>');
        expectExact(
            svg(
                `${content}<g mask="url(#m)"><rect width="12" height="24" fill="#E53935"/>` +
                    '<rect x="12" width="12" height="24" fill="#3949AB"/></g>',
            ),
        );
        const overlapping = svg(
            `${content}<g mask="url(#m)"><rect width="16" height="24" fill="#E53935"/>` +
                '<rect x="8" width="16" height="24" fill="#3949AB"/></g>',
        );
        for (const optimize of MODES)
            expect(convert(overlapping, { optimize }).warnings.map((w) => w.code)).toEqual(['opacity-approximated']);
    });

    it('fades each element of a shared mask once', () => {
        const doc = svg(
            maskOf('<rect x="4" y="4" width="16" height="16" fill="#808080"/>', ' maskUnits="userSpaceOnUse"') +
                '<path d="M0 0h12v24H0z" fill="#E53935" mask="url(#m)"/><path d="M12 0h12v24H12z" fill="#3949AB" mask="url(#m)"/>',
        );
        expect(fillAlphas(expectExact(doc, 2))).toEqual(['0.502', '0.502']);
    });

    it('keeps the warning for non-uniform content', () => {
        const twoValues =
            '<rect x="2" y="2" width="10" height="10" fill="#fff"/><rect x="12" y="12" width="10" height="10" fill="#808080"/>';
        expectRefused(svg(maskOf(twoValues) + FULL), /not uniform/);
        // White under black: the black shape cuts a hole, which is no uniform value.
        const hole = '<rect width="24" height="24" fill="#fff"/><rect x="8" y="8" width="8" height="8"/>';
        expectRefused(svg(maskOf(hole) + FULL), /not uniform/);
    });

    it('keeps the warning for overlapping translucent shapes (their values compose)', () => {
        const half = 'fill="#fff" fill-opacity="0.5"';
        const content = `<rect x="2" y="2" width="12" height="12" ${half}/><rect x="8" y="8" width="12" height="12" ${half}/>`;
        expectRefused(svg(maskOf(content) + FULL), /translucent content with overlapping shapes/);
    });

    it('keeps the warning for a gray mask under color-interpolation="linearRGB", not for a white one', () => {
        const gray = '<rect x="4" y="4" width="16" height="16" fill="#808080"/>';
        expectRefused(svg(maskOf(gray, ' color-interpolation="linearRGB"') + FULL), /linearRGB/);
        expectRefused(svg(`<g color-interpolation="linearRGB">${maskOf(gray)}</g>${FULL}`), /linearRGB/);
        const white = '<rect x="4" y="4" width="16" height="16" fill="#fff"/>';
        expectExact(svg(maskOf(white, ' color-interpolation="linearRGB"') + FULL));
    });

    describe('nested masks', () => {
        const INNER = '<mask id="i" maskUnits="userSpaceOnUse"><rect width="12" height="24" fill="#fff"/></mask>';
        const MASKED_CIRCLE = '<circle cx="12" cy="12" r="9" fill="#fff" mask="url(#i)"/>';
        const SIDE = '<rect x="16" y="16" width="6" height="6" fill="#fff"/>';

        it('intersects the clips of a mask on the element making up the mask content', () => {
            expectExact(svg(INNER + maskOf(MASKED_CIRCLE) + FULL), 2);
            // Under a transformed group, with a transform on the masked element.
            const transformed =
                '<g transform="translate(2 1)"><circle cx="10" cy="11" r="9" fill="#fff" mask="url(#i)" transform="rotate(30 10 11)"/></g>';
            expectExact(svg(INNER + maskOf(transformed) + FULL), 2);
        });

        it('multiplies the values of both levels', () => {
            const inner =
                '<mask id="i" maskUnits="userSpaceOnUse"><rect width="12" height="24" fill="#808080"/></mask>';
            const outer = maskOf('<circle cx="12" cy="12" r="9" fill="#808080" mask="url(#i)"/>');
            const xml = expectExact(svg(inner + outer + FULL), 2);
            expect(Number(fillAlphas(xml)[0])).toBeCloseTo(0.502 * 0.502, 3);
        });

        it('drops a masked element that only paints strokes (Figma stroke inside a mask)', () => {
            // After brave/leo country-ms: a filled shape and its stroke, masked by the shape itself.
            const SHAPE = 'M6 6c0 7-.5 12 6 12s6-6 6-12z';
            const doc = svg(
                `<mask id="m" maskUnits="userSpaceOnUse" x="4" y="4" width="16" height="16"><path fill="#fff" d="${SHAPE}"/>` +
                    `<mask id="e" fill="#fff"><path d="${SHAPE}"/></mask><path fill="none" stroke="#fff" d="${SHAPE}" mask="url(#e)"/></mask>` +
                    FULL,
            );
            for (const optimize of MODES) {
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings.map((w) => w.code)).toEqual(['mask-approximated']);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize);
            }
        });

        it('keeps the warning when a level is not exact', () => {
            // A masked element next to other content: a union of intersections is no clip.
            expectRefused(svg(INNER + maskOf(SIDE + MASKED_CIRCLE) + FULL), /masked element next to other content/);
            expectRefused(svg(INNER + maskOf(MASKED_CIRCLE + SIDE) + FULL), /masked element next to other content/);
            // The inner mask is not clip-equivalent.
            const inexact =
                '<mask id="i"><rect width="12" height="24" fill="#fff"/><rect x="12" width="12" height="24" fill="#808080"/></mask>';
            expectRefused(svg(inexact + maskOf(MASKED_CIRCLE) + FULL), /mask inside the mask \(.*not uniform/);
            // After brave/leo country-sh: a stroke-only element under a Figma "outside stroke" mask
            // (white rect, black shape on top) is not dropped: its inner mask is not exact.
            const SHAPE = 'M6 6c0 7-.5 12 6 12s6-6 6-12z';
            const outside = `<mask id="g" fill="#000"><path fill="#fff" d="M4 4h16v16H4z"/><path d="${SHAPE}"/></mask>`;
            const content = `<path fill="#fff" d="${SHAPE}"/>${outside}<path fill="none" stroke="#fff" d="${SHAPE}" mask="url(#g)"/>`;
            expectRefused(svg(maskOf(content) + FULL), /mask inside the mask \(.*not uniform/);
        });

        it('refuses a mask used inside its own content', () => {
            const selfMasked = maskOf('<circle cx="12" cy="12" r="9" fill="#fff" mask="url(#m)"/>');
            expectRefused(svg(selfMasked + FULL), /inside its own content/);
        });
    });
});
