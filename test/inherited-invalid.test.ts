import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { hasIgnoredPresentationValue, isUsablePaint } from '../src/inherited.js';

// A presentation attribute (or `style` declaration) invalid for its property is ignored: the
// parent's value applies (CSS 2.1 §4.2, SVG 2 §6.6). Expected values checked in Chrome 157 and Firefox 158.
const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;
const GRADIENT =
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>';

/** The value as an attribute and as an inline `style` declaration. */
const forms = (name: string, value: string): string[] => [`${name}="${value}"`, `style="${name}:${value}"`];

describe.each([false, true])('invalid inherited values (optimize: %s)', (optimize) => {
    const run = (body: string): { xml: string; codes: string[] } => {
        const { xml, warnings } = convert(svg(body), { optimize });
        return { xml, codes: warnings.map((w) => w.code) };
    };

    it.each(['foo', '-3'])('stroke-width="%s" keeps the inherited width, no warning', (value) => {
        for (const decl of forms('stroke-width', value)) {
            const { xml, codes } = run(`<g stroke="#000" stroke-width="10"><line x2="20" y2="20" ${decl}/></g>`);
            expect(codes).toEqual([]);
            expect(xml).toContain('android:strokeWidth="10"');
        }
    });

    it('fill-opacity and stroke-linecap keep the inherited values, no warning', () => {
        for (const [opacity, linecap] of [
            ['fill-opacity="foo"', 'stroke-linecap="foo"'],
            ['style="fill-opacity:foo;stroke-linecap:foo"', ''],
        ]) {
            const { xml, codes } = run(
                `<g fill-opacity="0.5" stroke-linecap="round" stroke="#000"><rect width="10" height="10" ${opacity} ${linecap}/></g>`,
            );
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillAlpha="0.5"');
            expect(xml).toContain('android:strokeLineCap="round"');
        }
    });

    it('stroke-width="1ex" (valid, not resolvable) is still reported', () => {
        const { xml, codes } = run('<rect width="10" height="10" stroke="#000" stroke-width="1ex"/>');
        expect(codes).toEqual(['unsupported-attribute']);
        expect(xml).toContain('android:strokeWidth="1"');
    });

    it.each(['notacolor', 'currentColor'])('color="%s": currentColor stays the parent color', (value) => {
        for (const decl of forms('color', value)) {
            const { xml, codes } = run(
                `<g color="#f00"><rect width="10" height="10" ${decl} fill="currentColor"/></g>`,
            );
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillColor="#FFFF0000"');
        }
    });

    it('a typo in the style color lets the color attribute apply', () => {
        const { xml, codes } = run(
            '<g color="#f00"><rect width="10" height="10" style="color:notacolor" color="#00f" fill="currentColor"/></g>',
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF0000FF"');
    });

    // CSS Variables 1 §3.1: a declaration with a substitution wins over the attribute, then acts as
    // `unset` when it cannot be substituted (none here): the parent's value, reported.
    describe('substitutions (var(), env(), attr())', () => {
        it.each(['var(--c)', 'env(x)', 'attr(data-c)'])(
            'color="%s": currentColor is the parent color, reported where painted',
            (value) => {
                for (const decl of [...forms('color', value), `style="color:${value}" color="#00f"`]) {
                    const { xml, codes } = run(
                        `<g style="--c:#00f" color="#f00"><rect width="10" height="10" ${decl} fill="currentColor"/></g>`,
                    );
                    expect(codes).toEqual(['unsupported-paint']);
                    expect(xml).toContain('android:fillColor="#FFFF0000"');
                }
            },
        );

        it('an unresolved color is reported on the shapes below that paint currentColor only', () => {
            const { xml, codes } = run(
                '<g color="#f00"><g color="var(--c)"><rect width="10" height="10" fill="#0f0"/>' +
                    '<rect width="10" height="10" stroke="currentColor" fill="none"/>' +
                    '<rect width="10" height="10" color="#00f" fill="currentColor"/></g></g>',
            );
            expect(codes).toEqual(['unsupported-paint']);
            expect(xml).toContain('android:strokeColor="#FFFF0000"');
            expect(xml).toContain('android:fillColor="#FF0000FF"');
        });

        it('fill-opacity: var() over the attribute is the parent value, reported', () => {
            for (const decl of ['style="fill-opacity:var(--o)" fill-opacity="1"', 'fill-opacity="var(--o)"']) {
                const { xml, codes } = run(`<g fill-opacity="0.5"><rect width="10" height="10" ${decl}/></g>`);
                expect(codes).toEqual(['unsupported-style']);
                expect(xml).toContain('android:fillAlpha="0.5"');
            }
        });

        it('an unresolved stroke property is not reported on a path without stroke', () => {
            const { codes } = run('<rect width="10" height="10" style="stroke-width:var(--w)"/>');
            expect(codes).toEqual([]);
            const stroked = run('<rect width="10" height="10" stroke="#000" style="stroke-width:var(--w)"/>');
            expect(stroked.codes).toEqual(['unsupported-style']);
            expect(stroked.xml).toContain('android:strokeWidth="1"');
        });

        it('a valid value below an unresolved one is not reported', () => {
            const { xml, codes } = run(
                '<g style="fill-opacity:var(--o)"><rect width="10" height="10" fill-opacity="0.5"/></g>',
            );
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillAlpha="0.5"');
        });

        it.each(['var(--x)', 'env(x)'])('style="fill:%s" over the attribute is the parent fill, reported', (value) => {
            const { xml, codes } = run(
                `<g fill="#0f0"><rect width="10" height="10" style="fill:${value}" fill="#00f"/></g>`,
            );
            expect(codes).toEqual(['unsupported-paint']);
            expect(xml).toContain('android:fillColor="#FF00FF00"');
        });

        it('rejected by strict', () => {
            for (const body of [
                '<g color="#f00"><rect width="10" height="10" color="var(--c)" fill="currentColor"/></g>',
                '<g fill-opacity="0.5"><rect width="10" height="10" style="fill-opacity:var(--o)"/></g>',
            ])
                expect(() => convert(svg(body), { optimize, strict: true })).toThrow();
        });
    });

    it.each(['inherit', 'initial', 'unset'])('fill="url(#g) %s" is dropped: the inherited fill, no warning', (kw) => {
        for (const decl of forms('fill', `url(#g) ${kw}`)) {
            const { xml, codes } = run(`${GRADIENT}<g fill="#0f0"><rect width="10" height="10" ${decl}/></g>`);
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillColor="#FF00FF00"');
            expect(xml).not.toContain('<gradient');
        }
    });

    it('fill="url(#g) notacolor" is dropped: the inherited fill, no warning', () => {
        for (const decl of forms('fill', 'url(#g) notacolor')) {
            const { xml, codes } = run(`${GRADIENT}<g fill="#0f0"><rect width="10" height="10" ${decl}/></g>`);
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillColor="#FF00FF00"');
            expect(xml).not.toContain('<gradient');
        }
    });

    it.each(['url(#g) env(x)', 'url(#absent) env(x)'])(
        'fill="%s" is ignored (reported): the inherited fill',
        (value) => {
            for (const decl of forms('fill', value)) {
                const { xml, codes } = run(`${GRADIENT}<g fill="#0f0"><rect width="10" height="10" ${decl}/></g>`);
                expect(codes).toEqual(['unsupported-paint']);
                expect(xml).toContain('android:fillColor="#FF00FF00"');
                expect(xml).not.toContain('<gradient');
            }
        },
    );

    it.each(['url(#g)', 'url(#g) red', 'url(#g) none', 'url(#g) currentColor'])(
        'fill="%s" paints the gradient',
        (value) => {
            const { xml, codes } = run(`${GRADIENT}<g fill="#0f0"><rect width="10" height="10" fill="${value}"/></g>`);
            expect(codes).toEqual([]);
            expect(xml).toContain('<gradient');
        },
    );

    // Non-local reference with an invalid fallback: the declaration does not parse, whatever the URL.
    const PARENT = '<g fill="#0f0" stroke="#00f">';
    it.each(['url(x.svg#g) foo', 'url(x.svg#g) inherit', "url('x.svg#g') foo"])(
        'fill="%s" is dropped: the inherited fill and stroke, no warning, strict passes',
        (value) => {
            for (const decl of forms('fill', value)) {
                const body = `${PARENT}<rect width="10" height="10" ${decl}/></g>`;
                const { xml, codes } = run(body);
                expect(codes).toEqual([]);
                expect(xml).toContain('android:fillColor="#FF00FF00"');
                expect(xml).toContain('android:strokeColor="#FF0000FF"');
                expect(() => convert(svg(body), { optimize, strict: true })).not.toThrow();
            }
        },
    );

    it('stroke="url(x.svg#g) foo" is dropped: the inherited stroke, no warning, strict passes', () => {
        for (const decl of forms('stroke', 'url(x.svg#g) foo')) {
            const body = `${PARENT}<rect width="10" height="10" ${decl}/></g>`;
            const { xml, codes } = run(body);
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillColor="#FF00FF00"');
            expect(xml).toContain('android:strokeColor="#FF0000FF"');
            expect(() => convert(svg(body), { optimize, strict: true })).not.toThrow();
        }
    });

    it('fill="url(x.svg#g) red" still falls back to red, reported (T-124)', () => {
        const { xml, codes } = run(`${PARENT}<rect width="10" height="10" fill="url(x.svg#g) red"/></g>`);
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
    });

    it('fill="url(x.svg#g)" still paints nothing, reported (T-145)', () => {
        const { xml, codes } = run(`${PARENT}<rect width="10" height="10" fill="url(x.svg#g)"/></g>`);
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).not.toContain('android:fillColor');
        expect(xml).toContain('android:strokeColor="#FF0000FF"');
    });

    it('fill="bogus" falls back like style="fill:bogus": the inherited fill, no warning', () => {
        for (const decl of forms('fill', 'bogus')) {
            const { xml, codes } = run(`<g fill="#0f0"><rect width="10" height="10" ${decl}/></g>`);
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillColor="#FF00FF00"');
        }
    });
});

describe('isUsablePaint', () => {
    it.each([
        'url(#g)',
        'url(#g) none',
        'url(#g) red',
        "url('#g') #00f",
        'url(#g) currentColor',
        'url(x.svg)',
        'url(x.svg#g) red',
    ])('%s', (v) => expect(isUsablePaint(v)).toBe(true));
    it.each(['url(#g) env(x)', 'url(#g) notacolor', 'env(x)', 'url(x.svg#g) foo', "url('x.svg#g') inherit"])(
        'not %s',
        (v) => expect(isUsablePaint(v)).toBe(false),
    );
});

describe('hasIgnoredPresentationValue (svgo guard)', () => {
    it.each([
        '<line stroke-width="foo"/>',
        "<line stroke-width='-3'/>",
        '<rect fill-opacity="foo"/>',
        '<rect color="env(x)"/>',
        '<rect color="currentColor"/>',
        '<rect style="color: var(--c) !important"/>',
        '<rect style="fill-opacity:var(--o)"/>',
        '<line stroke-width="env(x)"/>',
    ])('%s', (s) => expect(hasIgnoredPresentationValue(s)).toBe(true));
    it.each([
        '<line stroke-width="2"/>',
        '<line stroke-width="1ex"/>',
        '<rect fill-opacity=".5" color="#f00"/>',
        '<rect style="stroke-linecap:round"/>',
        '<rect data-color="env(x)"/>',
    ])('not %s', (s) => expect(hasIgnoredPresentationValue(s)).toBe(false));
});
