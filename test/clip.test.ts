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

            it('measures a <switch> by the child it renders', () => {
                const doc = svg(`<switch clip-path="circle()"><rect ${RECT}/></switch>`);
                expect(codes(doc, optimize)).toEqual([]);
                expectRendersLike(doc, optimize, clipped('<circle cx="12" cy="12" r="8"/>'));
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

    // No nonzero equivalent by orientation: filled nonzero (the union), reported as lossy, like an
    // evenodd clip-path (T-66).
    it('fills content whose evenodd contours cross nonzero, with a lossy warning', () => {
        const content = (rule: string): string =>
            `<mask id="m"><path d="M2 2h12v12H2zM8 8h12v12H8z" fill="#fff" fill-rule="${rule}"/></mask>${SQUARE}`;
        const doc = svg(content('evenodd'));
        for (const optimize of MODES) {
            const messages = maskMessages(doc, optimize);
            expect(messages).toHaveLength(1);
            expect(messages[0]).toMatch(/evenodd.*crossing.*nonzero is used/);
            expect(codes(doc, optimize)).toEqual(['unsupported-attribute']);
            expect(clipCount(convert(doc, { optimize }).xml)).toBe(1);
            expectRendersLike(doc, optimize, svg(content('nonzero')));
            expect(() => convert(doc, { optimize, strict: 'lossy' })).toThrow(/nonzero is used/);
        }
    });

    it('reports the nonzero fill once per mask, whatever the number of masked elements', () => {
        const doc = svg(
            '<mask id="m" maskContentUnits="objectBoundingBox"><path d="M0 0h.6v.6H0zM.4 .4h.6v.6h-.6z" fill="#fff" fill-rule="evenodd"/></mask>' +
                '<rect width="10" height="10" fill="#E53935" mask="url(#m)"/><rect x="12" y="12" width="10" height="10" fill="#1E88E5" mask="url(#m)"/>',
        );
        for (const optimize of MODES) expect(maskMessages(doc, optimize)).toHaveLength(1);
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
    });

    it('keeps the warning for overlapping translucent shapes (their values compose)', () => {
        const half = 'fill="#fff" fill-opacity="0.5"';
        const content = `<rect x="2" y="2" width="12" height="12" ${half}/><rect x="8" y="8" width="12" height="12" ${half}/>`;
        expectRefused(svg(maskOf(content) + FULL), /translucent content with overlapping shapes/);
    });

    it('linearizes a gray mask under color-interpolation="linearRGB" (on the mask or inherited)', () => {
        // Chrome and Firefox: #808080 reads 0.216 in linearRGB; resvg ignores linearRGB, so the
        // reference is the sRGB gray of the same luminance (#373737 = 55/255).
        const gray = '<rect x="4" y="4" width="16" height="16" fill="#808080"/>';
        const reference = svg(maskOf('<rect x="4" y="4" width="16" height="16" fill="#373737"/>') + FULL);
        for (const doc of [
            svg(maskOf(gray, ' color-interpolation="linearRGB"') + FULL),
            svg(`<g color-interpolation="linearRGB">${maskOf(gray)}</g>${FULL}`),
        ])
            for (const optimize of MODES) {
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(1);
                expect(Number(fillAlphas(xml)[0])).toBeCloseTo(0.216, 3);
                expectRendersLike(doc, optimize, reference);
            }
        // An sRGB mask under a linearRGB ancestor reads the encoded value.
        const back = svg(
            `<g color-interpolation="linearRGB">${maskOf(gray, ' color-interpolation="sRGB"')}</g>${FULL}`,
        );
        expect(fillAlphas(expectExact(back))).toEqual(['0.502']);
        // White and black are left unchanged by linearizing.
        const white = '<rect x="4" y="4" width="16" height="16" fill="#fff"/>';
        expect(fillAlphas(expectExact(svg(maskOf(white, ' color-interpolation="linearRGB"') + FULL)))).toEqual([]);
        const hole = '<rect width="24" height="24" fill="#fff"/><rect x="8" y="8" width="8" height="8" fill="#000"/>';
        expectExact(svg(maskOf(hole, ' color-interpolation="linearRGB"') + FULL));
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
        });

        it('refuses a mask used inside its own content', () => {
            const selfMasked = maskOf('<circle cx="12" cy="12" r="9" fill="#fff" mask="url(#m)"/>');
            expectRefused(svg(selfMasked + FULL), /inside its own content/);
        });
    });
});

describe('masks cutting black holes in a white rectangle (T-12)', () => {
    // Figma "outside stroke" masks (brave/leo country-*): a white rectangle, then black shapes on top.
    const SHAPE = 'M6 6c0 7-.5 12 6 12s6-6 6-12z';
    const RECT = '<path fill="#fff" d="M4 4h16v16H4z"/>';
    const FULL = '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>';
    const maskOf = (content: string, attrs = ''): string => `<mask id="m"${attrs}>${content}</mask>`;

    function expectExact(doc: string): void {
        for (const optimize of MODES) {
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings).toEqual([]);
            expect(xml).not.toContain('mask');
            expect(clipCount(xml)).toBe(1);
            expectRendersLike(doc, optimize);
        }
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
        ['a curved shape (inheriting fill="#000" from the mask)', `<path d="${SHAPE}"/>`, ' fill="#000"'],
        ['a <rect>', '<rect x="8" y="8" width="8" height="8"/>', ''],
        ['an evenodd ring', '<path fill-rule="evenodd" d="M6 6h12v12H6zM9 9h6v6H9z"/>', ''],
        ['a nonzero ring (opposite windings)', '<path d="M6 6h12v12H6zM9 9v6h6V9z"/>', ''],
        ['a reversed shape', '<path d="M8 8v8h8V8z"/>', ''],
        [
            'two disjoint shapes',
            '<rect x="5" y="5" width="5" height="5"/><rect x="12" y="12" width="6" height="6"/>',
            '',
        ],
        ['a shape touching the edge', '<rect x="4" y="8" width="8" height="8" fill="black"/>', ''],
    ])('clips by subtraction for %s', (_, holes, attrs) => {
        expectExact(svg(maskOf(RECT + holes, attrs) + FULL));
    });

    it('cuts the hole out of a translucent or gray rectangle, and under objectBoundingBox content', () => {
        expectExact(svg(maskOf(`<path fill="#808080" d="M4 4h16v16H4z"/><path d="${SHAPE}"/>`) + FULL));
        expectExact(
            svg(maskOf(`<rect width="24" height="24" fill="#fff" fill-opacity="0.5"/><path d="${SHAPE}"/>`) + FULL),
        );
        const box = '<rect width="1" height="1" fill="#fff"/><rect x="0.25" y="0.25" width="0.5" height="0.5"/>';
        expectExact(svg(maskOf(box, ' maskContentUnits="objectBoundingBox"') + FULL));
    });

    it('converts a stroke drawn under an outside-stroke mask exactly (brave/leo country-sh)', () => {
        const outside = `<mask id="m" maskUnits="userSpaceOnUse" x="4" y="4" width="16" height="16" fill="#000">${RECT}<path d="${SHAPE}"/></mask>`;
        expectExact(svg(`${outside}<path fill="none" stroke="#E53935" stroke-width="3" d="${SHAPE}" mask="url(#m)"/>`));
    });

    it('drops a stroke-only element under such a mask inside another mask (mask-approximated)', () => {
        const outside = `<mask id="g" fill="#000">${RECT}<path d="${SHAPE}"/></mask>`;
        const content = `<path fill="#fff" d="${SHAPE}"/>${outside}<path fill="none" stroke="#fff" d="${SHAPE}" mask="url(#g)"/>`;
        const doc = svg(maskOf(content) + FULL);
        for (const optimize of MODES) {
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings.map((w) => w.code)).toEqual(['mask-approximated']);
            expect(clipCount(xml)).toBe(1);
        }
    });

    it.each([
        ['a shape not entirely inside', '<rect x="16" y="16" width="8" height="8"/>', /not uniform/],
        [
            'overlapping shapes',
            '<rect x="6" y="6" width="8" height="8"/><rect x="10" y="10" width="8" height="8"/>',
            /not uniform/,
        ],
        ['a translucent black shape', '<rect x="8" y="8" width="8" height="8" fill-opacity="0.5"/>', /not uniform/],
        ['a nested contour of the same winding', '<path d="M6 6h12v12H6zM9 9h6v6H9z"/>', /not uniform/],
        ['crossing contours', '<path fill-rule="evenodd" d="M6 6h8v8H6zM10 10h8v8h-8z"/>', /not uniform/],
        [
            'white painted over the hole',
            '<rect x="8" y="8" width="8" height="8"/><rect x="10" y="10" width="2" height="2" fill="#fff"/>',
            /paints over a hole/,
        ],
    ])('keeps the warning for %s', (_, holes, reason) => {
        expectRefused(svg(maskOf(RECT + holes) + FULL), reason);
    });

    it('keeps the warning when the white content is not one rectangle', () => {
        const hole = '<rect x="8" y="8" width="2" height="2"/>';
        expectRefused(svg(maskOf(`<circle cx="12" cy="12" r="8" fill="#fff"/>${hole}`) + FULL), /not uniform/);
        const two =
            '<rect x="4" y="4" width="8" height="16" fill="#fff"/><rect x="12" y="4" width="8" height="16" fill="#fff"/>';
        expectRefused(svg(maskOf(two + hole) + FULL), /not uniform/);
        const rotated = '<rect x="4" y="4" width="16" height="16" fill="#fff" transform="rotate(10 12 12)"/>';
        expectRefused(svg(maskOf(rotated + hole) + FULL), /not uniform/);
        // Black first: the white rectangle paints over it (no hole), still another value.
        expectRefused(svg(maskOf(hole + RECT) + FULL), /not uniform/);
    });

    it('unites a black shape with the rectangle of an alpha mask (alpha 1: no hole)', () => {
        const doc = svg(maskOf(`${RECT}<rect x="8" y="8" width="8" height="8"/>`, ' mask-type="alpha"') + FULL);
        for (const optimize of MODES) {
            const { warnings } = convert(doc, { optimize });
            expect(warnings).toEqual([]);
            expectRendersLike(doc, optimize);
        }
    });
});

describe('unresolved shape lengths in clip and mask content (T-29)', () => {
    const lengthWarnings = (doc: string, optimize: boolean) =>
        convert(doc, { optimize }).warnings.filter((w) => w.message.includes('is not a length'));

    it('warns once for a clipPath rect width in ex used by two elements', () => {
        const doc = svg(
            '<clipPath id="c"><rect x="4" y="4" width="1ex" height="16"/></clipPath>' +
                '<g clip-path="url(#c)">' +
                CIRCLE +
                '</g><g clip-path="url(#c)">' +
                CIRCLE +
                '</g>',
        );
        for (const optimize of MODES) {
            const warnings = lengthWarnings(doc, optimize);
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-attribute', 'rect']]);
            expect(warnings[0]!.message).toBe(
                'width="1ex" on <rect> is not a length the converter can resolve (ex, ch, calc()…); 0 is used.',
            );
        }
    });

    it('warns for a mask content circle radius in ex', () => {
        const doc = svg(
            '<mask id="m"><rect x="4" y="4" width="16" height="16" fill="#fff"/>' +
                '<circle cx="12" cy="12" r="1ex" fill="#fff"/></mask>' +
                '<path d="M0 0h24v24H0z" fill="#E53935" mask="url(#m)"/>',
        );
        for (const optimize of MODES) {
            const warnings = lengthWarnings(doc, optimize);
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-attribute', 'circle']]);
            expect(warnings[0]!.message).toMatch(/^r="1ex" on <circle>/);
        }
    });
});

describe('<switch> bounding box and systemLanguage in clip and mask content (T-47)', () => {
    const SQUARE = '<rect x="4" y="4" width="16" height="16" fill="#E53935"/>';
    const BIG = '<rect x="0" y="0" width="24" height="24" fill="#3949AB"/>';
    const MASK = '<mask id="m" maskContentUnits="objectBoundingBox"><rect width="0.5" height="1" fill="#fff"/></mask>';
    // The <switch> renders SQUARE only: BIG is skipped by its condition, or comes after the pick.
    const SWITCHES = [
        ['one child', SQUARE],
        ['requiredExtensions on the first child', BIG.replace('/>', ' requiredExtensions="x"/>') + SQUARE],
        ['an empty systemLanguage on the first child', BIG.replace('/>', ' systemLanguage=""/>') + SQUARE],
        ['a second child', SQUARE + BIG],
    ] as const;

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const [name, children] of SWITCHES) {
                it.each([
                    ['inset(4px)', '<rect x="8" y="8" width="8" height="8" fill="#E53935"/>'],
                    ['circle()', '<circle cx="12" cy="12" r="8" fill="#E53935"/>'],
                ])(`clips a <switch> with ${name} by its child's box: %s`, (shape, reference) => {
                    const doc = svg(`<switch clip-path="${shape}">${children}</switch>`);
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(clipCount(xml)).toBe(1);
                    expectRendersLike(doc, optimize, svg(reference));
                });

                it(`masks a <switch> with ${name} in objectBoundingBox units`, () => {
                    const doc = svg(`${MASK}<switch mask="url(#m)">${children}</switch>`);
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(xml).not.toContain('mask');
                    expectRendersLike(doc, optimize, svg('<rect x="4" y="4" width="8" height="16" fill="#E53935"/>'));
                });
            }

            it('measures a <switch> inside a measured group, and one without child as empty', () => {
                const nested = svg(`<g clip-path="inset(4px)"><switch>${SQUARE}</switch><switch/></g>`);
                expect(convert(nested, { optimize, strict: true }).warnings).toEqual([]);
                expectRendersLike(nested, optimize, svg('<rect x="8" y="8" width="8" height="8" fill="#E53935"/>'));
            });

            it('measures the child a language-dependent <switch> renders (reported once by the renderer)', () => {
                const doc = svg(
                    `<switch clip-path="inset(4px)">${BIG.replace('/>', ' systemLanguage="zz"/>')}${SQUARE}</switch>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings.map((w) => w.message)).toEqual([expect.stringMatching(/children of <switch>/)]);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize, svg('<rect x="8" y="8" width="8" height="8" fill="#E53935"/>'));
            });

            it('reports a non-empty systemLanguage on <clipPath> and <mask> content (used as if it passed)', () => {
                const clip = svg(
                    `<clipPath id="c"><rect systemLanguage="zz" x="4" y="4" width="16" height="16"/></clipPath>${BIG.replace('/>', ' clip-path="url(#c)"/>')}`,
                );
                const mask = svg(
                    `<mask id="m"><g systemLanguage="zz"><rect x="4" y="4" width="16" height="16" fill="#fff"/></g></mask>${BIG.replace('/>', ' mask="url(#m)"/>')}`,
                );
                for (const doc of [clip, mask]) {
                    const { xml, warnings } = convert(doc, { optimize });
                    expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
                    expect(warnings[0]!.message).toMatch(/^systemLanguage on <\w+> depends on the device language/);
                    expect(clipCount(xml)).toBe(1);
                    expect(() => convert(doc, { optimize, strict: true })).toThrow(/systemLanguage/);
                }
            });
        });
    }
});

describe('empty <clipPath> and <switch> in clip and mask content (T-75)', () => {
    // CSS Masking 1 §6.1: a clipping path without rendered content clips the element away entirely.
    const DOT = '<circle cx="3" cy="3" r="2" fill="#1E88E5"/>';
    const RED = '<rect width="24" height="24" fill="#E53935"';
    const EMPTY_CLIPS = [
        ['no child', '<clipPath id="c"/>'],
        ['an empty group', '<clipPath id="c"><g/></clipPath>'],
        ['a display="none" child', '<clipPath id="c"><rect width="10" height="10" display="none"/></clipPath>'],
        [
            'a style="display:none" group',
            '<clipPath id="c"><g style="display:none"><rect width="10" height="10"/></g></clipPath>',
        ],
        ['a failing condition', '<clipPath id="c"><rect requiredExtensions="" width="10" height="10"/></clipPath>'],
        [
            'a <switch> (not a permitted child)',
            '<clipPath id="c"><switch><rect width="10" height="10"/></switch></clipPath>',
        ],
    ] as const;

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const [name, clip] of EMPTY_CLIPS) {
                it(`draws nothing of an element clipped by a <clipPath> with ${name}, without warning`, () => {
                    for (const target of [
                        `${RED} clip-path="url(#c)"/>`,
                        `<g clip-path="url(#c)">${RED}/></g>`,
                        `<g clip-path="url(#c)" transform="rotate(30 12 12)">${RED}/></g>`,
                    ]) {
                        const doc = svg(`${clip}${target}${DOT}`);
                        const { xml, warnings } = convert(doc, { optimize, strict: true });
                        expect(warnings).toEqual([]);
                        expectRendersLike(doc, optimize, svg(DOT));
                        if (!target.includes('rotate')) expect(xml).not.toContain('E53935');
                    }
                });
            }

            it('ignores a <switch> next to other <clipPath> content, without warning', () => {
                const doc = svg(
                    `<clipPath id="c"><switch><rect width="24" height="24"/></switch><rect x="4" y="4" width="8" height="8"/></clipPath>${RED} clip-path="url(#c)"/>`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize, svg('<rect x="4" y="4" width="8" height="8" fill="#E53935"/>'));
            });

            it('keeps the warning (and the unclipped element) for content that cannot be converted', () => {
                const doc = svg(`<clipPath id="c"><text>x</text></clipPath>${RED} clip-path="url(#c)"/>`);
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings.map((w) => w.code)).toEqual(['unsupported-clip-path', 'unsupported-clip-path']);
                expect(warnings[0]!.message).toMatch(/<text> inside a <clipPath> cannot be converted/);
                expect(warnings[1]!.message).toMatch(/produced no geometry/);
                expect(xml).toContain('E53935');
            });

            it('masks by the child a <switch> inside a <mask> picks, like a group', () => {
                const doc = svg(
                    `<mask id="m"><switch><rect requiredExtensions="" width="24" height="24" fill="#fff"/><rect width="10" height="10" fill="#fff"/><rect width="24" height="24" fill="#fff"/></switch></mask>${RED} mask="url(#m)"/>`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(xml).not.toContain('mask');
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize, svg('<rect width="10" height="10" fill="#E53935"/>'));
            });

            it('treats a <mask> whose <switch> picks nothing like an empty mask', () => {
                const doc = svg(`<mask id="m"><switch/></mask>${RED} mask="url(#m)"/>${DOT}`);
                const empty = svg(`<mask id="m"/>${RED} mask="url(#m)"/>${DOT}`);
                expect(codes(doc, optimize)).toEqual(codes(empty, optimize));
            });
        });
    }
});

describe('empty <mask> and zero-size <clipPath> content (T-102)', () => {
    // CSS Masking 1 §7.1: no rendered mask content is a mask value of 0 everywhere; §6.1 for clips.
    const DOT = '<circle cx="3" cy="3" r="2" fill="#1E88E5"/>';
    const RED = '<rect width="24" height="24" fill="#E53935"';
    const TARGETS = [
        (ref: string, id: string) => `${RED} ${ref}="url(#${id})"/>`,
        (ref: string, id: string) => `<g ${ref}="url(#${id})">${RED}/></g>`,
        (ref: string, id: string) => `<g ${ref}="url(#${id})" transform="rotate(30 12 12)">${RED}/></g>`,
    ];
    const EMPTY_MASKS = [
        ['no child', '<mask id="m"/>'],
        ['a <switch> that picks nothing', '<mask id="m"><switch/></mask>'],
        ['a zero-size shape', '<mask id="m"><rect width="0" height="5" fill="#fff"/></mask>'],
        ['a hidden shape', '<mask id="m"><rect width="10" height="10" fill="#fff" display="none"/></mask>'],
        ['an empty region', '<mask id="m" maskUnits="userSpaceOnUse" width="0"/>'],
    ] as const;
    const ZERO_CLIPS = [
        ['a zero-width rect', '<clipPath id="c"><rect width="0" height="10"/></clipPath>'],
        ['a zero-radius circle', '<clipPath id="c"><circle cx="5" cy="5" r="0"/></clipPath>'],
        ['a path without d', '<clipPath id="c"><path/></clipPath>'],
    ] as const;
    const cases = [
        ...EMPTY_MASKS.map(([name, def]) => [`a <mask> with ${name}`, def, 'mask', 'm'] as const),
        ...ZERO_CLIPS.map(([name, def]) => [`a <clipPath> with ${name}`, def, 'clip-path', 'c'] as const),
    ];

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const [name, def, ref, id] of cases) {
                it(`draws nothing of an element under ${name}, without warning`, () => {
                    for (const target of TARGETS) {
                        const doc = svg(`${def}${target(ref, id)}${DOT}`);
                        const { xml, warnings } = convert(doc, { optimize, strict: true });
                        expect(warnings).toEqual([]);
                        expectRendersLike(doc, optimize, svg(DOT));
                        // A rotated group keeps its clip on the group: drawn content clipped away.
                        if (target !== TARGETS[2]) expect(xml).not.toContain('E53935');
                    }
                });
            }

            it('ignores a zero-size shape next to other <clipPath> content', () => {
                const doc = svg(
                    `<clipPath id="c"><rect width="0" height="10"/><rect x="4" y="4" width="8" height="8"/></clipPath>${RED} clip-path="url(#c)"/>`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize, svg('<rect x="4" y="4" width="8" height="8" fill="#E53935"/>'));
            });

            it('hides the content of a mask whose own content is masked by an empty mask', () => {
                const doc = svg(
                    `<mask id="e"/><mask id="m"><rect width="10" height="10" fill="#fff" mask="url(#e)"/></mask>${RED} mask="url(#m)"/>${DOT}`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expectRendersLike(doc, optimize, svg(DOT));
                expect(xml).not.toContain('E53935');
            });

            it('keeps refusing a mask whose content only paints strokes', () => {
                const doc = svg(
                    `<mask id="m"><rect width="10" height="10" fill="none" stroke="#fff"/></mask>${RED} mask="url(#m)"/>`,
                );
                const { warnings } = convert(doc, { optimize });
                expect(warnings.map((w) => w.message).join('\n')).toMatch(/only paints strokes/);
            });
        });
    }
});

describe('empty clip on a group kept as an Android <group> (T-117)', () => {
    const BODY = '<path d="M0 0h10v10H0z" fill="#E53935"/>';
    const DOT = '<circle cx="20" cy="20" r="2" fill="#1E88E5"/>';

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            it('drops a translated group clipped by an empty <clipPath>, without warning', () => {
                const doc = svg(
                    `<clipPath id="c"/><g transform="translate(2 3)" clip-path="url(#c)">${BODY}</g>${DOT}`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(xml).not.toContain('<group');
                expect(xml).not.toContain('M0,0Z');
                expect(xml).not.toContain('E53935');
                expectRendersLike(doc, optimize, svg(DOT));
            });

            it('drops a named group clipped by an empty <clipPath> and frees its name (preserveIds)', () => {
                const doc = svg(
                    `<clipPath id="c"/><g id="a" transform="translate(2 3)" clip-path="url(#c)">${BODY}</g>${DOT}`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true, preserveIds: true });
                expect(warnings).toEqual([]);
                expect(xml).not.toContain('<group');
                expect(xml).not.toContain('M0,0Z');
                expect(xml).not.toContain('android:name="a"');
                expect(xml).not.toContain('E53935');
            });

            it('drops a named untransformed group clipped by an empty <clipPath> (preserveIds)', () => {
                const doc = svg(`<clipPath id="c"/><g id="a" clip-path="url(#c)">${BODY}</g>${DOT}`);
                const { xml, warnings } = convert(doc, { optimize, strict: true, preserveIds: true });
                expect(warnings).toEqual([]);
                expect(xml).not.toContain('<group');
                expect(xml).not.toContain('E53935');
            });

            it('keeps a translated group with a non-empty clip unchanged', () => {
                const doc = svg(
                    `<clipPath id="c"><rect width="5" height="5"/></clipPath><g transform="translate(2 3)" clip-path="url(#c)">${BODY}</g>`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(xml).toContain('android:translateX="2"');
                expect(clipCount(xml)).toBe(1);
                expect(xml).toContain('E53935');
                expectRendersLike(doc, optimize);
            });
        });
    }
});

describe('clip precision under a scale above 1 (T-134)', () => {
    const TINY_CLIP = '<clipPath id="c"><rect x="0.00123" y="0.00123" width="0.01" height="0.01"/></clipPath>';
    const TINY = '<rect width="0.024" height="0.024"/>';
    const SCALED_CLIP =
        '<clipPath id="c" transform="scale(1000)"><rect x="0.00123" y="0.00377" width="0.0104" height="0.0104"/></clipPath>';
    const OBB_MASK =
        '<mask id="m" maskContentUnits="objectBoundingBox"><rect x="0.123456" y="0.123456" width="0.5" height="0.5" fill="#fff"/></mask>';
    const clipData = (xml: string): string[] =>
        [...xml.matchAll(/<clip-path android:pathData="([^"]*)"/g)].map((m) => m[1]!);

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            it('keeps the decimals of a clip on a leaf under scale(1000)', () => {
                const doc = svg(
                    `${TINY_CLIP}<g transform="scale(1000)"><rect width="0.024" height="0.024" clip-path="url(#c)"/></g>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml).join()).toContain('.00123');
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of a clip on a group scaled by 1000', () => {
                const doc = svg(`${TINY_CLIP}<g transform="scale(1000)" clip-path="url(#c)">${TINY}</g>`);
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml).join()).toContain('.00123');
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of clip content under its own transform="scale(1000)"', () => {
                const doc = svg(`${SCALED_CLIP}<rect width="24" height="24" clip-path="url(#c)"/>`);
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml)[0]).toMatch(/^M1\.23[ ,]3\.77/);
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of a clip on a group whose scale(1000) is baked (skew)', () => {
                const doc = svg(
                    `${TINY_CLIP}<g transform="matrix(1000 0 300 1000 0 0)" clip-path="url(#c)">${TINY}</g>`,
                );
                expect(convert(doc, { optimize }).warnings).toEqual([]);
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of a clip on a leaf under a baked scale(1000)', () => {
                const doc = svg(
                    `${TINY_CLIP}<g transform="skewX(10)"><g transform="scale(1000)"><rect width="0.024" height="0.024" clip-path="url(#c)"/></g></g>`,
                );
                expect(convert(doc, { optimize }).warnings).toEqual([]);
                expectRendersLike(doc, optimize);
            });

            it('resolves one clip at each precision it is drawn at, reported once', () => {
                const clip =
                    '<clipPath id="c"><rect x="0.00123" y="0.00123" width="0.01" height="0.01"/><path clip-rule="evenodd" d="M0.02 0.02L0.03 0.03L0.03 0.02L0.02 0.03Z"/></clipPath>';
                const doc = svg(
                    `${clip}<rect width="0.012" height="0.012" clip-path="url(#c)"/><g transform="scale(1000)"><rect width="0.024" height="0.024" clip-path="url(#c)"/></g>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                const data = clipData(xml);
                expect(data).toHaveLength(2);
                // Rounded to 3 decimals at the top level (svgo keeps them: it paths the rect itself).
                if (!optimize) expect(data[0]).toMatch(/^M0\.001,0\.001/);
                expect(data[1]).toContain('.00123');
                expect(warnings.filter((w) => w.code === 'unsupported-clip-path')).toHaveLength(1);
            });

            it('keeps floatPrecision decimals in an objectBoundingBox mask', () => {
                const doc = svg(`${OBB_MASK}<rect x="2" y="2" width="20" height="20" mask="url(#m)"/>`);
                const { xml, warnings } = convert(doc, { optimize, floatPrecision: 5 });
                expect(warnings).toEqual([]);
                // svgo rounds the mask content to 5 decimals in bbox units first (0.12346 × 20).
                expect(clipData(xml)[0]).toMatch(optimize ? /^M4\.4692 4\.4692/ : /^M4\.46912 4\.46912/);
                expectRendersLike(doc, optimize);
            });
        });
    }

    // optimize: false only: svgo rounds the clip content itself.
    it('leaves a clip unchanged without a scale above 1', () => {
        const doc = svg(
            `${TINY_CLIP}<g transform="scale(0.5)"><rect width="0.024" height="0.024" clip-path="url(#c)"/></g>`,
        );
        expect(clipData(convert(doc, { optimize: false }).xml)).toEqual(['M0.001,0.001h0.01v0.01h-0.01z']);
    });

    it('scales the precision of objectBoundingBox mask content by the box size', () => {
        const doc = svg(`${OBB_MASK}<rect x="2" y="2" width="20" height="20" mask="url(#m)"/>`);
        expect(clipData(convert(doc, { optimize: false, floatPrecision: 2 }).xml)[0]).toMatch(/^M4\.47 4\.47/);
    });
});

describe('mask precision under a scale above 1 (T-140)', () => {
    const TINY_MASK =
        '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="0.02" height="0.02"><rect x="0.00123" y="0.00123" width="0.01" height="0.01" fill="#fff"/></mask>';
    const TINY = '<rect width="0.024" height="0.024"/>';
    const clipData = (xml: string): string[] =>
        [...xml.matchAll(/<clip-path android:pathData="([^"]*)"/g)].map((m) => m[1]!);

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            it('keeps the decimals of a mask on a leaf under scale(1000)', () => {
                const doc = svg(
                    `${TINY_MASK}<g transform="scale(1000)"><rect width="0.024" height="0.024" mask="url(#m)"/></g>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml).join()).toContain('.00123');
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of a mask on a group scaled by 1000', () => {
                const doc = svg(`${TINY_MASK}<g transform="scale(1000)" mask="url(#m)">${TINY}</g>`);
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml).join()).toContain('.00123');
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of a mask on a leaf with its own transform="scale(1000)"', () => {
                const doc = svg(
                    `${TINY_MASK}<rect transform="scale(1000)" width="0.024" height="0.024" mask="url(#m)"/>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml).join()).toContain('.00123');
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of a mask on a leaf under a baked scale(1000)', () => {
                const doc = svg(
                    `${TINY_MASK}<g transform="skewX(10)"><g transform="scale(1000)"><rect width="0.024" height="0.024" mask="url(#m)"/></g></g>`,
                );
                expect(convert(doc, { optimize }).warnings).toEqual([]);
                expectRendersLike(doc, optimize);
            });

            it('keeps the decimals of a nested mask under scale(1000)', () => {
                const doc = svg(
                    `${TINY_MASK}<mask id="n" maskUnits="userSpaceOnUse" x="0" y="0" width="0.02" height="0.02"><rect width="0.02" height="0.02" fill="#fff" mask="url(#m)"/></mask>` +
                        `<g transform="scale(1000)"><rect width="0.024" height="0.024" mask="url(#n)"/></g>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml).join()).toContain('.00123');
                expectRendersLike(doc, optimize);
            });

            it('measures the objectBoundingBox of a masked element under scale(1000) at its precision', () => {
                const doc = svg(
                    '<mask id="o" maskContentUnits="objectBoundingBox"><rect x="0.25" y="0.25" width="0.5" height="0.5" fill="#fff"/></mask>' +
                        '<g transform="scale(1000)"><rect x="0.00123" y="0.00123" width="0.01" height="0.01" mask="url(#o)"/></g>',
                );
                const { xml, warnings } = convert(doc, { optimize });
                expect(warnings).toEqual([]);
                expect(clipData(xml).join()).toContain('.00373');
                expectRendersLike(doc, optimize);
            });

            it('resolves one mask at each precision it is drawn at, reported once', () => {
                const mask =
                    '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="0.02" height="0.02"><rect x="0.00123" y="0.00123" width="0.01" height="0.01" fill="#fff" stroke="#fff" stroke-width="0.001"/></mask>';
                const doc = svg(
                    `${mask}<rect width="0.012" height="0.012" mask="url(#m)"/><g transform="scale(1000)"><rect width="0.024" height="0.024" mask="url(#m)"/></g>`,
                );
                const { xml, warnings } = convert(doc, { optimize });
                const data = clipData(xml);
                expect(data).toHaveLength(2);
                expect(data[0]).not.toContain('.00123');
                expect(data[1]).toContain('.00123');
                expect(warnings.map((w) => w.code)).toEqual(['mask-approximated']);
            });
        });
    }

    // optimize: false only: svgo rounds the mask content itself.
    it('leaves a mask unchanged without a scale above 1', () => {
        const doc = svg(
            `${TINY_MASK}<g transform="scale(0.5)"><rect width="0.024" height="0.024" mask="url(#m)"/></g>`,
        );
        expect(clipData(convert(doc, { optimize: false }).xml)).toEqual(['M.001.001h.01v.01H.001Z']);
    });
});

describe('invalid transform in <clipPath> and <mask> content (T-88)', () => {
    const ignored = (value: string, node: string) => ({
        code: 'unsupported-attribute',
        message: `transform="${value}" on <${node}> is not a valid transform list; ignored.`,
        node,
    });
    // svgo turns the <rect> into a <path>: the warning names the element it reads, like a drawn shape's.
    const rectNode = (optimize: boolean): string => (optimize ? 'path' : 'rect');
    const RECT = '<rect width="12" height="12" fill="#fff"/>';
    const CLIPPED = '<rect width="24" height="24" clip-path="url(#c)"/>';
    const MASKED = '<rect width="24" height="24" mask="url(#m)"/>';
    const cases = (optimize: boolean) => [
        {
            name: 'on the <clipPath>',
            doc: svg(`<clipPath id="c" transform="translate(foo 5)">${RECT}</clipPath>${CLIPPED}`),
            reference: svg(`<clipPath id="c">${RECT}</clipPath>${CLIPPED}`),
            warning: ignored('translate(foo 5)', 'clipPath'),
        },
        {
            name: 'on <clipPath> content',
            doc: svg(
                `<clipPath id="c"><rect transform="translate(foo 2)" width="12" height="12"/></clipPath>${CLIPPED}`,
            ),
            reference: svg(`<clipPath id="c">${RECT}</clipPath>${CLIPPED}`),
            warning: ignored('translate(foo 2)', rectNode(optimize)),
        },
        {
            // A <g> is no permitted child of <clipPath> (svgo drops it): only in mask content.
            name: 'on a group in <mask> content',
            doc: svg(`<mask id="m"><g transform="rotate(foo)">${RECT}</g></mask>${MASKED}`),
            reference: svg(`<mask id="m">${RECT}</mask>${MASKED}`),
            warning: ignored('rotate(foo)', 'g'),
        },
        {
            name: 'on <mask> content',
            doc: svg(
                `<mask id="m"><rect transform="translate(foo 2)" width="12" height="12" fill="#fff"/></mask>${MASKED}`,
            ),
            reference: svg(`<mask id="m">${RECT}</mask>${MASKED}`),
            warning: ignored('translate(foo 2)', rectNode(optimize)),
        },
    ];

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const { name, doc, reference, warning } of cases(optimize)) {
                it(`reports an invalid transform ${name} and ignores it`, () => {
                    const { xml, warnings } = convert(doc, { optimize });
                    expect(warnings).toEqual([warning]);
                    expect(xml).toBe(convert(reference, { optimize }).xml);
                    expectRendersLike(doc, optimize, reference);
                    expect(() => convert(doc, { optimize, strict: true })).toThrow(/not a valid transform list/);
                });
            }

            it('reports an invalid transform in a clip used twice once', () => {
                const doc = svg(
                    `<clipPath id="c"><rect transform="translate(foo 2)" width="12" height="12"/></clipPath>` +
                        `${CLIPPED}<g transform="scale(1000)"><rect width="0.024" height="0.024" clip-path="url(#c)"/></g>`,
                );
                expect(convert(doc, { optimize }).warnings).toEqual([ignored('translate(foo 2)', rectNode(optimize))]);
            });

            it('does not report an empty or valid transform in clip content', () => {
                const doc = svg(
                    `<clipPath id="c" transform=""><rect transform="translate(2 2)" width="12" height="12"/></clipPath>${CLIPPED}`,
                );
                expect(convert(doc, { optimize, strict: true }).warnings).toEqual([]);
            });
        });
    }
});

describe('content dropped by a clip that clips everything (T-125)', () => {
    const GRADIENT =
        '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>';
    const FILLED = '<rect width="10" height="10" fill="url(#g)"/>';
    const DOT = '<rect x="12" width="5" height="5"/>';
    const cases = [
        ['a group', `<clipPath id="c"/><g clip-path="url(#c)">${FILLED}</g>`],
        ['a transformed group', `<clipPath id="c"/><g transform="translate(1 1)" clip-path="url(#c)">${FILLED}</g>`],
        ['a group whose skew is baked', `<clipPath id="c"/><g transform="skewX(10)" clip-path="url(#c)">${FILLED}</g>`],
        ['a leaf', `<clipPath id="c"/><rect width="10" height="10" fill="url(#g)" clip-path="url(#c)"/>`],
        ['an empty mask', `<mask id="m"/><g mask="url(#m)">${FILLED}</g>`],
    ] as const;

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const [name, content] of cases) {
                it(`declares no aapt namespace for a gradient in ${name} clipped away`, () => {
                    const { xml, warnings } = convert(svg(`${GRADIENT}${content}${DOT}`), { optimize });
                    // The content is still rendered, then dropped: its own warnings remain (gradient-under-skew).
                    expect(warnings.filter((w) => w.code !== 'gradient-under-skew')).toEqual([]);
                    expect(xml).not.toContain('xmlns:aapt');
                    expect(xml).not.toContain('<gradient');
                    expect(xml).toContain('M12');
                });
            }

            it('keeps the aapt namespace for a gradient drawn next to the clipped-away one', () => {
                const doc = svg(`${GRADIENT}<clipPath id="c"/><g clip-path="url(#c)">${FILLED}</g>${FILLED}`);
                expect(convert(doc, { optimize }).xml).toContain('xmlns:aapt');
            });

            it('frees the names of content clipped away (preserveIds)', () => {
                const doc = svg(
                    '<clipPath id="vide"/><g clip-path="url(#vide)"><path id="p" d="M0 0h5v5z"/></g><path id="p" d="M6 0h5v5z"/>',
                );
                const { xml } = convert(doc, { optimize, preserveIds: true });
                expect(xml).toContain('android:name="p"');
                expect(xml).not.toContain('M0 0');
            });

            it('frees the names of a named group clipped away and of its content (preserveIds)', () => {
                const doc = svg(
                    '<clipPath id="vide"/><g id="a" transform="translate(1 1)" clip-path="url(#vide)"><path id="p" d="M0 0h5v5z"/></g>' +
                        '<g id="a"><path id="p" d="M6 0h5v5z"/></g>',
                );
                const { xml } = convert(doc, { optimize, preserveIds: true });
                expect(xml).toContain('android:name="a"');
                expect(xml).toContain('android:name="p"');
            });
        });
    }
});

describe('<g> and <a> directly in a <clipPath> (T-149)', () => {
    // Not permitted children (CSS Masking 1 §6.1): Chrome and Firefox clip everything away with only
    // such a child; next to permitted content, Chrome ignores the group (followed here).
    const DOT = '<circle cx="3" cy="3" r="2" fill="#1E88E5"/>';
    const RED = '<rect width="24" height="24" fill="#E53935"';
    const SQUARE = '<rect width="12" height="12"/>';

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const name of ['g', 'a']) {
                it(`draws nothing of an element clipped by a <clipPath> holding only a <${name}>, without warning`, () => {
                    const doc = svg(
                        `<clipPath id="c"><${name}>${SQUARE}</${name}></clipPath>${RED} clip-path="url(#c)"/>${DOT}`,
                    );
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(xml).not.toContain('E53935');
                    expectRendersLike(doc, optimize, svg(DOT));
                });
            }

            it('ignores a <g> next to other <clipPath> content, without warning', () => {
                const doc = svg(
                    `<clipPath id="c">${SQUARE}<g><rect x="12" width="12" height="24"/></g></clipPath>${RED} clip-path="url(#c)"/>`,
                );
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize, svg('<rect width="12" height="12" fill="#E53935"/>'));
            });

            it('keeps the content of a <use> in a <clipPath>, positioned and transformed', () => {
                for (const use of ['<use href="#r"/>', '<use href="#r" x="6" transform="rotate(10)"/>']) {
                    const doc = svg(
                        `<defs><rect id="r" width="12" height="12"/></defs><clipPath id="c">${use}</clipPath>${RED} clip-path="url(#c)"/>`,
                    );
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(clipCount(xml)).toBe(1);
                    expectRendersLike(doc, optimize);
                }
            });
        });
    }
});

describe('<use> of a container in a <clipPath> (T-155)', () => {
    // A <use> in a <clipPath> must reference a shape or a text (CSS Masking 1 §6.1): Chrome and
    // Firefox clip everything away with a <use> of a <g>, <symbol>, <svg> or another <use>.
    const DOT = '<circle cx="3" cy="3" r="2" fill="#1E88E5"/>';
    const RED = '<rect width="24" height="24" fill="#E53935"';
    const PAIR = '<rect width="12" height="12"/><rect x="12" width="6" height="6"/>';
    const clipped = (defs: string, clip: string): string =>
        svg(`<defs>${defs}</defs><clipPath id="c">${clip}</clipPath>${RED} clip-path="url(#c)"/>${DOT}`);
    // Two children: svgo's collapseGroups would otherwise move the id of a one-child <g> onto its child.
    const CONTAINERS: Record<string, string> = {
        '<g>': `<g id="t">${PAIR}</g>`,
        '<a>': `<a id="t">${PAIR}</a>`,
        '<symbol>': `<symbol id="t" width="24" height="24">${PAIR}</symbol>`,
        '<symbol viewBox>': `<symbol id="t" viewBox="0 0 24 24" width="24" height="24">${PAIR}</symbol>`,
        '<svg>': `<svg id="t" width="24" height="24">${PAIR}</svg>`,
        '<use> of a <rect>': '<rect id="r" width="12" height="12"/><use id="t" href="#r"/>',
        '<use> of a <g>': `<g id="g">${PAIR}</g><use id="t" href="#g"/>`,
        '<use> of a <use> of a <path>':
            '<path id="p" d="M0 0H12V12H0Z"/><use id="u" href="#p"/><use id="t" href="#u"/>',
    };

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            for (const [name, defs] of Object.entries(CONTAINERS)) {
                it(`draws nothing of an element clipped by a <use> of a ${name}, without warning`, () => {
                    const doc = clipped(defs, '<use href="#t" x="2"/>');
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(xml).not.toContain('E53935');
                    expectRendersLike(doc, optimize, svg(DOT));
                });
            }

            it('ignores a <use> of a <g> next to other <clipPath> content, without warning', () => {
                const doc = clipped(CONTAINERS['<g>']!, '<use href="#t"/><rect y="12" width="24" height="12"/>');
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(clipCount(xml)).toBe(1);
                expectRendersLike(doc, optimize, svg(`<rect y="12" width="24" height="12" fill="#E53935"/>${DOT}`));
            });

            it('keeps a <use> of a <path> or a <rect>, positioned', () => {
                for (const target of ['<path id="t" d="M0 0H12V12H0Z"/>', '<rect id="t" width="12" height="12"/>']) {
                    const doc = clipped(target, '<use href="#t" x="6" y="6"/>');
                    const { xml, warnings } = convert(doc, { optimize, strict: true });
                    expect(warnings).toEqual([]);
                    expect(clipCount(xml)).toBe(1);
                    expectRendersLike(
                        doc,
                        optimize,
                        svg(`<rect x="6" y="6" width="12" height="12" fill="#E53935"/>${DOT}`),
                    );
                }
            });
        });
    }

    // svgo's collapseGroups would move the id of a one-child <g> onto its child (T-162).
    const ONE_CHILD: Record<string, string> = {
        '<g>': '<g id="t"><rect width="12" height="12"/></g>',
        '<g transform>': '<g id="t" transform="translate(2)"><rect width="12" height="12"/></g>',
        'nested <g>': '<g id="t"><g fill="blue"><rect width="12" height="12"/></g></g>',
        '<g> in an <a>': '<a><g id="t"><rect width="12" height="12"/></g></a>',
    };
    for (const optimize of MODES)
        for (const [name, defs] of Object.entries(ONE_CHILD))
            it(`draws nothing through a <use> of a one-child ${name} (optimize: ${optimize})`, () => {
                const doc = clipped(defs, '<use href="#t"/>');
                const { xml, warnings } = convert(doc, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(xml).not.toContain('E53935');
                expectRendersLike(doc, optimize, svg(DOT));
            });
});
