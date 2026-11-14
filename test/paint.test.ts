import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, ConversionError, type Warning } from '../src/index.js';
import { toAndroidColor } from '../src/color.js';
import { roundPathNumbers } from '../src/paint.js';
import { toAbsolute } from '../src/pathAbsolute.js';
import { parsePath } from '../src/pathParse.js';
import { vdToSvg } from './visual/vdToSvg.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

const reproDir = join(fileURLToPath(new URL('.', import.meta.url)), 'wpt-repro');
const repro = (name: string): string => readFileSync(join(reproDir, name), 'utf8');

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

const color = (value: string): string | null => toAndroidColor(value, undefined, '#000000');

describe.each([true, false])('wpt reproductions (optimize: %s)', (optimize) => {
    it('an unparseable paint (env()) is reported and falls back to the initial paint', () => {
        const source = repro('wpt-paint-invalid-value.svg');
        const { xml, warnings } = convert(source, { optimize });
        expect(warnings.map((w) => [w.code, w.message])).toEqual([
            ['unsupported-paint', expect.stringContaining('fill="env(--color, black)"')],
            ['unsupported-paint', expect.stringContaining('stroke="env(--stroke)"')],
        ]);
        // Renderers ignore the invalid values: black fill, no stroke.
        expect(xml).toContain('android:fillColor="#FF000000"');
        expect(xml).not.toContain('strokeColor');
        const result = compareSvgs(source, vdToSvg(xml));
        expect(result.inked).toBeGreaterThan(0);
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        expect(strictError(source, optimize)?.code).toBe('unsupported-paint');
    });

    it('a CSS Color 4 function (oklch()) is converted to the wpt reference color', () => {
        const source = repro('wpt-paint-color-function.svg');
        const { xml, warnings } = convert(source, { optimize });
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF339377"');
        // resvg paints oklch() black itself: compare against the wpt reference, not the source.
        const reference = source.replace('oklch(0.6 0.1 170)', '#339377');
        expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        expect(strictError(source, optimize)).toBeNull();
    });

    it('context-fill outside a <use> instance is reported (strict rejects it)', () => {
        // Resolved from the <use> since TASK-075 (test/useResolver.test.ts); the bare target has no context element.
        const source = repro('wpt-paint-context-fill.svg')
            .replace(/<\/?defs>/g, '')
            .replace(/<use[^>]*\/>/, '');
        const { warnings } = convert(source, { optimize });
        expect(warnings.map((w) => [w.code, w.message])).toEqual([
            ['unsupported-paint', expect.stringContaining('fill="context-fill"')],
        ]);
        expect(strictError(source, optimize)?.code).toBe('unsupported-paint');
    });
});

describe.each([true, false])('an invalid paint declaration is ignored, as CSS does (optimize: %s)', (optimize) => {
    const run = (body: string): { xml: string; warnings: [string, string][] } => {
        const { xml, warnings } = convert(svg(body), { optimize });
        return { xml, warnings: warnings.map((w) => [w.code, w.message]) };
    };
    const ignored = (property: string, value: string): [string, string] => [
        'unsupported-paint',
        expect.stringContaining(
            `${property}="${value}" is not a color the converter can parse; it is ignored`,
        ) as string,
    ];
    // svgo's collapseGroups (optimize: true) moves a lone child's own fill over the group's, losing
    // the value the invalid one falls back to: a sibling keeps the group.
    const sibling = '<rect x="20" width="1" height="1" fill="#0ff" stroke="none"/>';

    it('under a parent fill / stroke, the inherited value applies', () => {
        const { xml, warnings } = run(
            `<g fill="#f00" stroke="#0f0"><rect width="10" height="10" fill="env(--x)" stroke="var(--y)"/>${sibling}</g>`,
        );
        expect(warnings).toEqual([ignored('fill', 'env(--x)'), ignored('stroke', 'var(--y)')]);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('under a parent gradient, the inherited gradient applies', () => {
        const { xml, warnings } = run(
            '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
                `<g fill="url(#g)"><rect width="10" height="10" fill="env(--x)"/>${sibling}</g>`,
        );
        expect(warnings).toEqual([ignored('fill', 'env(--x)')]);
        expect(xml).toContain('<gradient');
    });

    it('without a parent value, the initial paint applies (black fill, no stroke)', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="env(--x)" stroke="env(--y)"/>');
        expect(warnings).toEqual([ignored('fill', 'env(--x)'), ignored('stroke', 'env(--y)')]);
        expect(xml).toContain('android:fillColor="#FF000000"');
        expect(xml).not.toContain('strokeColor');
    });

    // CSS Variables 1 §3.1: it wins over the attribute, then acts as `unset` (the parent's value).
    it('a style declaration with a substitution hides the presentation attribute: the parent value applies', () => {
        const { xml, warnings } = run(
            `<g fill="#f00" stroke="#0f0"><rect width="10" height="10" style="fill:env(x);stroke:var(--y)" fill="blue" stroke="#ff0"/>${sibling}</g>`,
        );
        expect(warnings).toEqual([ignored('fill', 'env(x)'), ignored('stroke', 'var(--y)')]);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('CSS-wide keywords: initial resets to the initial paint, unset / revert inherit', () => {
        const { xml, warnings } = run(
            `<g fill="#f00" stroke="#0f0"><rect width="10" height="10" fill="initial" stroke="initial"/>` +
                `<rect x="12" width="10" height="10" fill="unset" stroke="revert"/>${sibling}</g>`,
        );
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF000000"');
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('an invalid style declaration over an invalid attribute lets the parent value apply', () => {
        const { xml, warnings } = run(
            `<g fill="#f00"><rect width="10" height="10" style="fill:env(x)" fill="var(--y)"/>${sibling}</g>`,
        );
        expect(warnings).toEqual([ignored('fill', 'env(x)')]);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
    });

    it('an invalid group paint is skipped: its children inherit the grandparent value', () => {
        const { xml, warnings } = run(
            `<g fill="#f00"><g fill="env(--x)"><rect width="10" height="10"/>${sibling}</g>` +
                `<g fill="env(--x)"><rect x="12" width="10" height="10" fill="#00f"/>${sibling}</g></g>`,
        );
        // Reported for the shape that inherits through it, not for the one that sets its own fill.
        expect(warnings).toEqual([ignored('fill', 'env(--x)')]);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).toContain('android:fillColor="#FF0000FF"');
    });

    it('strict mode still rejects the ignored declaration', () => {
        expect(
            strictError(svg('<g fill="#f00"><rect width="1" height="1" fill="env(--x)"/></g>'), optimize)?.code,
        ).toBe('unsupported-paint');
    });
});

describe('unparseable paints', () => {
    const run = (body: string, options = {}): { xml: string; codes: string[]; messages: string[] } => {
        const { xml, warnings } = convert(svg(body), { optimize: false, ...options });
        return { xml, codes: warnings.map((w) => w.code), messages: warnings.map((w) => w.message) };
    };

    it.each(['var(--brand)', 'color-mix(in srgb, red, blue)', 'rgb(from red r g b)', 'light-dark(red, blue)'])(
        'fill="%s" warns and paints the initial black fill',
        (value) => {
            const { xml, codes } = run(`<rect width="10" height="10" fill="${value}"/>`);
            expect(codes).toEqual(['unsupported-paint']);
            expect(xml).toContain('android:fillColor="#FF000000"');
        },
    );

    it('fill="redd" is dropped like a browser does (attribute or style): the initial black fill, no warning', () => {
        for (const paint of ['fill="redd"', 'style="fill:redd"']) {
            const { xml, codes } = run(`<rect width="10" height="10" ${paint}/>`);
            expect(codes).toEqual([]);
            expect(xml).toContain('android:fillColor="#FF000000"');
        }
    });

    it('context-stroke drops the stroke, keeps the fill, and warns', () => {
        const { xml, codes, messages } = run(
            '<rect width="10" height="10" fill="#f00" stroke="context-stroke" stroke-width="2"/>',
        );
        expect(codes).toEqual(['unsupported-paint']);
        expect(messages[0]).toContain('stroke="context-stroke"');
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).not.toContain('strokeColor');
    });

    it('an unparseable fill is dropped (still reported) when fillBlackForUnfilled is false', () => {
        const { xml, codes } = run('<rect width="10" height="10" fill="var(--x)" stroke="#00f"/>', {
            fillBlackForUnfilled: false,
        });
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).not.toContain('fillColor');
        expect(xml).toContain('android:strokeColor="#FF0000FF"');
    });

    it('an unparseable fallback after a missing url(#…) is reported', () => {
        const { xml, codes } = run('<rect width="10" height="10" fill="url(#missing) var(--x)"/>');
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).toContain('android:fillColor="#FF000000"');
    });

    it('parseable paints (none, transparent, currentColor, CSS Color 4) are not reported', () => {
        const { codes } = run(
            '<rect width="1" height="1" fill="none" stroke="transparent"/>' +
                '<rect width="1" height="1" fill="currentColor"/>' +
                '<rect width="1" height="1" fill="lab(50 20 -30)" stroke="hwb(90 10% 10%)"/>',
        );
        expect(codes).toEqual([]);
    });
});

it('a CSS Color 4 color minified by svgo (<style>, optimize: true) is still converted', () => {
    const { xml, warnings } = convert(
        svg('<style>rect{fill:lab(54.9182952 -34.7227492 6.3628745)}</style>' + '<rect width="10" height="10"/>'),
        { optimize: true },
    );
    expect(warnings).toEqual([]);
    expect(xml).toContain('android:fillColor="#FF339377"');
});

describe('toAndroidColor: CSS Color 4', () => {
    // web-platform-tests svg/painting/reftests/paint-fill-attr-*.svg (wpt 76f5455a): every one is
    // expected to render like paint-fill-ref.svg, i.e. #339377.
    it.each([
        'rgb(51, 147, 119)',
        'rgb(19.8349%, 57.7612%, 46.663%)',
        'rgb(19.8349% 57.7612% 46.663%)',
        'hsl(162.442474, 48.8765544%, 38.79805%)',
        'hsl(162.442474 48.8765544% 38.79805%)',
        'hwb(162.442474 19.8349% 42.2388%)',
        'lab(54.9182952 -34.7227492 6.3628745)',
        'lch(54.9182952 35.3009275 169.6158723)',
        'oklab(0.60000008 -0.09848081 0.01736487)',
        'oklch(0.6 0.1 170)',
        'color(srgb 0.198349 0.577612 0.46663)',
        'color(srgb-linear 0.0325927 0.293038 0.1844439)',
        'color(display-p3 0.3110533 0.5697676 0.4727867)',
        'color(a98-rgb 0.3616266 0.5722774 0.4687185)',
        'color(prophoto-rgb 0.3353498 0.4775274 0.4028578)',
        'color(rec2020 0.4203502 0.5829114 0.5022449)',
        'color(xyz 0.1515153 0.2298175 0.2108785)',
        'color(xyz-d65 0.1515153 0.2298175 0.2108785)',
        'color(xyz-d50 0.1534665 0.2285077 0.1606136)',
    ])('%s → #FF339377 (wpt reference)', (value) => {
        expect(color(value)).toBe('#FF339377');
        expect(color(value.toUpperCase())).toBe('#FF339377');
    });

    it.each([
        ['rgb(20% 50% 50%)', '#FF338080'],
        ['oklch(0.6 0.1 170 / 50%)', '#80339377'],
        ['oklab(0.6 -0.0985 0.0174 / 0.25)', '#40339377'],
        ['color(srgb 1 0 0 / 0.5)', '#80FF0000'],
        ['hsl(0.5turn 100% 50%)', '#FF00FFFF'],
        ['hsl(200grad 100 50)', '#FF00FFFF'],
        ['hsl(3.14159265rad 100% 50%)', '#FF00FFFF'],
        ['hwb(0 100% 100%)', '#FF808080'],
        ['lab(100 0 0)', '#FFFFFFFF'],
        ['lab(0% none none)', '#FF000000'],
        ['oklch(100% 0 none)', '#FFFFFFFF'],
        ['lch(50% 0 0)', '#FF777777'],
        ['rgb(none 255 none)', '#FF00FF00'],
        ['color(xyz-d65 0.95047 1 1.08883)', '#FFFFFFFF'],
        // Minified (svgo / csso): CSS needs no space before a signed or dotted number.
        ['lab(54.9182952-34.7227492 6.3628745)', '#FF339377'],
        ['oklab(.60000008-.09848081 .01736487)', '#FF339377'],
        ['rgb(51 147 119/.5)', '#80339377'],
    ])('%s → %s', (value, expected) => {
        expect(color(value)).toBe(expected);
    });

    it('clips colors outside sRGB per channel (documented gamut mapping)', () => {
        expect(color('color(display-p3 1 0 0)')).toBe('#FFFF0000');
        expect(color('color(rec2020 0 1 0)')).toBe('#FF00FF00');
        expect(color('color(display-p3 0 1 0)')).toBe('#FF00FF00');
        expect(color('color(srgb 1.5 -0.5 0.5)')).toBe('#FFFF0080');
        expect(color('lab(150 0 0)')).toBe('#FFFFFFFF'); // L clamped to 100
    });

    it.each([
        'oklch(0.6, 0.1, 170)', // commas only in legacy rgb()/hsl()
        'oklch(0.6 0.1)',
        'oklch(0.6 0.1 170 0.5)', // the modern alpha needs a slash
        'lab(50 20 -30 / 1 / 1)',
        'lab(50 20 -30 /)',
        'lab(50 20 -30 / 1 1)',
        'lab(50 20 -30 ; 1)',
        'lab(50% 20px 0)',
        'lch(50 20 10px)',
        'hsl(120foo 50% 50%)',
        'color(unknown 1 0 0)',
        'color(1 0 0)',
        'color(srgb 1 0)',
        'oklch(calc(0.5) 0.1 170)',
        'rgb(1 2)',
        'rgb(a, b, c)',
        '#ggg',
        'device-cmyk(0 0 0 1)',
    ])('%s is unparseable (null)', (value) => {
        expect(color(value)).toBeNull();
    });

    it('keeps the legacy syntaxes and named colors', () => {
        expect(color('rgba(255, 0, 0, 0.5)')).toBe('#80FF0000');
        expect(color('hsla(120, 100%, 50%, 50%)')).toBe('#8000FF00');
        expect(color('#0f08')).toBe('#8800FF00');
        expect(color('rebeccapurple')).toBe('#FF663399');
        expect(color('transparent')).toBe('#00000000');
        expect(color('none')).toBeNull();
    });
});

describe('currentColor option', () => {
    it('accepts a CSS Color 4 color', () => {
        const { xml } = convert(svg('<rect width="10" height="10" fill="currentColor"/>'), {
            currentColor: 'oklch(0.6 0.1 170)',
        });
        expect(xml).toContain('android:fillColor="#FF339377"');
    });

    it.each(['env(--x)', 'context-fill', 'oklch(0.6, 0.1, 170)', 'nope'])(
        'still throws a TypeError for %s',
        (value) => {
            expect(() => convert(svg('<rect width="1" height="1"/>'), { currentColor: value })).toThrow(TypeError);
        },
    );
});

describe.each([true, false])('invalid gradient paint servers (optimize: %s)', (optimize) => {
    const stops = '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>';
    const singular = `<linearGradient id="g" gradientTransform="scale(0)">${stops}</linearGradient>`;
    const run = (body: string): { xml: string; warnings: [string, string][] } => {
        const { xml, warnings } = convert(svg(`<defs>${singular}</defs>${body}`), { optimize });
        return { xml, warnings: warnings.map((w) => [w.code, w.message]) };
    };
    const notPainted = (
        property: string,
        reason = 'a gradient that is not a valid paint server ',
    ): [string, string] => [
        'missing-gradient',
        expect.stringMatching(
            // svgo (optimize: true) may rename the id.
            new RegExp(`^${property}="url\\(#\\w+\\)" points at ${reason}.* the ${property} is not painted\\.$`),
        ) as string,
    ];
    const noStops = 'a gradient without stops, which paints none';
    const empty = (body: string): { xml: string; warnings: [string, string][] } => {
        const { xml, warnings } = convert(svg(`<defs><linearGradient id="e"/></defs>${body}`), { optimize });
        return { xml, warnings: warnings.map((w) => [w.code, w.message]) };
    };

    it('a fill on a singular gradientTransform without fallback paints nothing (SVG 2 §13.2)', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#g)"/>');
        expect(warnings).toEqual([notPainted('fill')]);
        expect(xml).not.toContain('<path');
        expect(xml).not.toContain('aapt');
    });

    it('keeps the stroke of a path whose invalid fill is not painted', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#g)" stroke="#0f0"/>');
        expect(warnings).toEqual([notPainted('fill')]);
        expect(xml).not.toContain('fillColor');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('a stroke on a singular gradientTransform without fallback is dropped, with an accurate message', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="#0f0" stroke="url(#g)"/>');
        expect(warnings).toEqual([notPainted('stroke')]);
        expect(xml).toContain('android:fillColor="#FF00FF00"');
        expect(xml).not.toContain('strokeColor');
    });

    it('a gradient without stops is not painted either (SVG 1.1 §13.2.4)', () => {
        const { xml, warnings } = empty('<rect width="10" height="10" fill="url(#e)" stroke="url(#e)"/>');
        expect(warnings).toEqual([notPainted('fill', noStops), notPainted('stroke', noStops)]);
        expect(xml).not.toContain('<path');
    });

    it('a gradient without stops paints none even over a fallback color (SVG 1.1 §13.2.4)', () => {
        const { xml, warnings } = empty('<rect width="10" height="10" fill="url(#e) #00f" stroke="url(#e) #0f0"/>');
        expect(warnings).toEqual([notPainted('fill', noStops), notPainted('stroke', noStops)]);
        expect(xml).not.toContain('<path');
    });

    it("names the author's gradient when context-fill / context-stroke take one without stops", () => {
        const { xml, warnings } = empty(
            '<defs><rect id="r" width="10" height="10" fill="context-fill" stroke="context-stroke"/></defs>' +
                '<use href="#r" fill="url(#e) red" stroke="url(#e) #0f0"/>',
        );
        expect(warnings).toEqual([notPainted('fill', noStops), notPainted('stroke', noStops)]);
        expect(warnings.map(([, message]) => message).join()).not.toContain('svgvd-');
        if (!optimize) expect(warnings[0]![1]).toMatch(/^fill="url\(#e\)"/);
        expect(xml).not.toContain('<path');
    });

    it('keeps the solid stroke of a path whose fill has a gradient without stops', () => {
        const { xml, warnings } = empty('<rect width="10" height="10" fill="url(#e) #00f" stroke="#0f0"/>');
        expect(warnings).toEqual([notPainted('fill', noStops)]);
        expect(xml).not.toContain('fillColor');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('uses the fallback color of an invalid gradient, without warning', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#g) #00f" stroke="url(#g) #0f0"/>');
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF0000FF"');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('paints nothing for an unknown reference without fallback (SVG 2 §13.2)', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#nope)" stroke="url(#nope)"/>');
        const unknown = (property: string): [string, string] => [
            'missing-gradient',
            `${property}="url(#nope)" points at nothing (unknown paint server), without fallback color; the ${property} is not painted.`,
        ];
        expect(warnings).toEqual([unknown('fill'), unknown('stroke')]);
        expect(xml).not.toContain('<path');
    });

    it('keeps the solid stroke of a path whose unknown fill reference is not painted', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#nope)" stroke="#0f0"/>');
        expect(warnings.map(([code]) => code)).toEqual(['missing-gradient']);
        expect(xml).not.toContain('fillColor');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('uses the fallback color of an unknown reference, without warning', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#nope) #00f" stroke="url(#nope) #0f0"/>');
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF0000FF"');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });
});

describe('roundPathNumbers: rounding in absolute coordinates', () => {
    /** Absolute end point of every drawing command (S, T and arcs lowered to C and Q). */
    const points = (d: string): [number, number][] =>
        toAbsolute(parsePath(d))
            .filter(({ cmd }) => cmd !== 'Z')
            .map(({ args }) => [args[args.length - 2]!, args[args.length - 1]!]);
    /** Largest gap between the end points of two paths with the same commands. */
    const drift = (a: string, b: string): number => {
        const [pa, pb] = [points(a), points(b)];
        expect(pa).toHaveLength(pb.length);
        return Math.max(0, ...pa.flatMap(([x, y], i) => [Math.abs(x - pb[i]![0]), Math.abs(y - pb[i]![1])]));
    };
    /** Deterministic pseudo-random numbers in [0, 1) (LCG), so a failure is reproducible. */
    const random = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;

    it('does not let relative rounding errors add up (measured on the icon corpus: up to 0.99 unit at precision 1)', () => {
        // Rounded one by one, every 0.14 becomes 0.1 and the end point lands at 0.4 instead of 0.42.
        expect(roundPathNumbers('M0 0l0.14 0l0.14 0l0.14 0', 1)).toBe('M0 0l0.1 0l0.2 0l0.1 0');
        expect(roundPathNumbers('M0.05 0h1.04h1.04v.06', 1)).toBe('M0.1 0h1h1v0.1');
        // Control points are rounded in absolute space too; a short number is kept as written.
        expect(roundPathNumbers('M0 0c.14 .14 .28 .28 .42 .42s.14 .1 .28 .28', 1)).toBe(
            'M0 0c0.1 0.1 0.3 0.3 0.4 0.4s0.2 .1 0.3 0.3',
        );
    });

    it.each([0, 1, 2])('keeps every point within half a unit of precision %i of the source', (precision) => {
        const next = random(precision + 1);
        const number = (): string => ((next() - 0.5) * 6).toFixed(3);
        const commands = ['l', 'h', 'v', 'c', 's', 'q', 't', 'L', 'C', 'z m'];
        const arity: Record<string, number> = { l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, L: 2, C: 6, 'z m': 2 };
        for (let run = 0; run < 50; run++) {
            let d = `M${number()} ${number()}`;
            for (let i = 0; i < 60; i++) {
                const cmd = commands[Math.floor(next() * commands.length)]!;
                d += `${cmd}${Array.from({ length: arity[cmd]! }, number).join(' ')}`;
            }
            const rounded = roundPathNumbers(d, precision);
            expect(drift(rounded, d)).toBeLessThanOrEqual(0.5 * 10 ** -precision + 1e-9);
            expect(rounded.match(/\.\d+/g)?.every((decimals) => decimals.length - 1 <= precision) ?? true).toBe(true);
        }
    });

    it('rounds a half-ellipse arc so that it stays one', () => {
        // Rounded as is, the radii no longer reach across the chord (12.72√2 < 18): the center leaves the midpoint.
        expect(roundPathNumbers('M5.636 5.636a9 9 0 1 1 12.728 12.728A9 9 0 0 1 5.636 5.636', 2)).toBe(
            'M5.64 5.64a8.99 8.99 0 1 1 12.72 12.72A8.99 8.99 0 0 1 5.64 5.64',
        );
        // A rotated half-ellipse (the rotation's sign matters): 4 2 would leave a center offset.
        expect(roundPathNumbers('M1.06 6.04a4 2 -30 1 1 6.928 -4', 1)).toBe('M1.1 6a3.9 1.9 -30 1 1 6.9 -4');
        // A genuine arc keeps its rounded radii (its center is far from the chord midpoint).
        expect(roundPathNumbers('M5.75 15A8.015 8.015 0 1 0 15 2', 1)).toBe('M5.8 15A8 8 0 1 0 15 2');
    });

    it('leaves malformed data rounded number by number', () => {
        expect(roundPathNumbers('0.14 M0 0l0.14 0x0.14l0.14 0', 1)).toBe('0.1 M0 0l0.1 0x0.1l0.1 0');
        expect(roundPathNumbers('M0 0l0.14 0z0.14 0.14', 1)).toBe('M0 0l0.1 0z0.1 0.1');
    });

    it.each([
        // Relative staircase: rounded one by one, 0.994 → 0.99 drifts by 0.004 a step (2.9 % mismatch).
        [2, `<path d="M2 2${'l.994 .47l.994 -.47'.repeat(10)}" stroke="#000" fill="none"/>`],
        // heroicons magnifying-glass: two half circles, 9.8 % mismatch once a rounded chord falls short of the diameter.
        [
            2,
            '<path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" stroke="#000" stroke-width="1.5" fill="none"/>',
        ],
    ])('renders like the source at floatPrecision %i (visual harness)', (floatPrecision, body) => {
        const source = svg(body);
        const result = compareSvgs(source, vdToSvg(convert(source, { floatPrecision }).xml));
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });
});

// SVG draws nothing for a zero stroke width, Android a hairline: no stroke attribute is written.
describe('a zero stroke width (rounded to zero included) is not emitted', () => {
    const both = (body: string): { xml: string; codes: string[] } => {
        const [on, off] = [true, false].map((optimize) => convert(svg(body), { optimize }));
        // pathData is written differently per mode (svgo's convertPathData): the rest is identical.
        const attrs = (xml: string): string => xml.replace(/android:pathData="[^"]*"/g, '');
        expect(attrs(off!.xml)).toBe(attrs(on!.xml));
        expect(off!.warnings).toEqual(on!.warnings);
        return { xml: on!.xml, codes: on!.warnings.map((w) => w.code) };
    };

    it.each([
        ['stroke-width="0"', '0'],
        ['stroke-width="0.0001"', '0.0001'],
        ['style="stroke-width:0px"', 'css 0px'],
    ])('%s with a fill: the fill only (%s)', (decl) => {
        const { xml, codes } = both(
            `<rect width="10" height="10" fill="green" stroke="blue" ${decl} stroke-linecap="round" stroke-dasharray="2"/>`,
        );
        expect(codes).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF008000"');
        expect(xml).not.toMatch(/stroke[A-Z]/);
    });

    it('stroke-width="0" without fill: nothing drawn', () => {
        const { xml, codes } = both('<rect width="10" height="10" fill="none" stroke="blue" stroke-width="0"/>');
        expect(codes).toEqual([]);
        expect(xml).not.toContain('<path');
    });

    // optimize: false keeps the transform as a <group> (no baking): optimize: true only.
    it('a stroke scaled to zero by a baked transform (optimize: true)', () => {
        const { xml, warnings } = convert(
            svg('<path d="M0 0H100000V100000H0z" transform="scale(0.0001)" fill="green" stroke="blue"/>'),
        );
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF008000"');
        expect(xml).not.toMatch(/stroke[A-Z]/);
    });

    it('a stroke gradient with zero width is not emitted either', () => {
        const { xml } = both(
            '<defs><linearGradient id="g"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
                '<rect width="10" height="10" fill="green" stroke="url(#g)" stroke-width="0"/>',
        );
        expect(xml).not.toContain('strokeColor');
        expect(xml).not.toContain('aapt');
    });

    it('stroke-width="0.01" keeps the stroke', () => {
        const { xml } = both('<rect width="10" height="10" fill="green" stroke="blue" stroke-width="0.01"/>');
        expect(xml).toContain('android:strokeColor="#FF0000FF"');
        expect(xml).toContain('android:strokeWidth="0.01"');
    });
});

// T-63 (option A): a <pattern> paint without fallback color paints nothing, fill as stroke; the fallback otherwise.
describe.each([true, false])('<pattern> paints (optimize: %s)', (optimize) => {
    const pattern = '<pattern id="p" width="2" height="2"><rect width="1" height="1" fill="#f00"/></pattern>';
    const run = (body: string): { xml: string; codes: string[] } => {
        const { xml, warnings } = convert(svg(pattern + body), { optimize });
        return { xml, codes: warnings.map((w) => w.code) };
    };

    it('fill="url(#p)" alone paints nothing, reported', () => {
        const { xml, codes } = run('<rect width="10" height="10" fill="url(#p)"/>');
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).not.toContain('<path');
        expect(() =>
            convert(svg(pattern + '<rect width="10" height="10" fill="url(#p)"/>'), { optimize, strict: true }),
        ).toThrow(ConversionError);
    });

    it('fill="url(#p)" with a stroke: the stroke only', () => {
        const { xml, codes } = run('<rect width="10" height="10" fill="url(#p)" stroke="#00f"/>');
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).not.toContain('fillColor');
        expect(xml).toContain('android:strokeColor="#FF0000FF"');
    });

    it('stroke="url(#p)" alone paints nothing, reported', () => {
        const { xml, codes } = run('<rect width="10" height="10" fill="none" stroke="url(#p)"/>');
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).not.toContain('<path');
    });

    it.each([
        ['fill', 'fillColor'],
        ['stroke', 'strokeColor'],
    ])('%s="url(#p) blue" uses the fallback color', (property, attr) => {
        const other = property === 'fill' ? '' : 'fill="none"';
        const { xml, codes } = run(`<rect width="10" height="10" ${other} ${property}="url(#p) blue"/>`);
        expect(codes).toEqual(['unsupported-paint']);
        expect(xml).toContain(`android:${attr}="#FF0000FF"`);
    });
});

describe.each([true, false])('an invalid length is not reported as an unresolvable unit (optimize: %s)', (optimize) => {
    const messages = (body: string): string[] => convert(svg(body), { optimize }).warnings.map((w) => w.message);

    // Still reported (T-129): Firefox uses `auto` (a circle), Chrome 0 (nothing drawn, `auto` unsupported too).
    it.each(['abc', '10abc'])('<ellipse rx="%s">: a circle, and the message cites the invalid value', (value) => {
        const { xml, warnings } = convert(svg(`<ellipse cx="12" cy="12" rx="${value}" ry="10"/>`), { optimize });
        expect(xml).toContain('<path');
        expect(warnings.map((w) => [w.code, w.message])).toEqual([
            ['unsupported-attribute', `rx="${value}" on <ellipse> is not a valid length; auto is used.`],
        ]);
        expect(warnings[0]!.message).not.toMatch(/\bex\b|calc\(/);
        expect(strictError(svg(`<ellipse cx="12" cy="12" rx="${value}" ry="10"/>`), optimize)?.code).toBe(
            'unsupported-attribute',
        );
    });

    // T-129: Chrome and Firefox use the initial value, as the converter does: reported exactly as the
    // initial value written out (a shape of size 0 keeps its `empty-path`, as with r="0").
    it.each([
        ['<rect x="10abc" width="5" height="5"/>', '<rect x="0" width="5" height="5"/>'],
        ['<rect x="2" width="abc" height="5"/>', '<rect x="2" width="0" height="5"/>'],
        ['<circle cx="12" cy="12" r="abc"/>', '<circle cx="12" cy="12" r="0"/>'],
        [
            '<line x1="2" y1="12" x2="abc" y2="12" stroke="#000"/>',
            '<line x1="2" y1="12" x2="0" y2="12" stroke="#000"/>',
        ],
        [
            '<svg x="2" width="abc" height="10" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
            '<svg x="2" width="100%" height="10" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
        ],
        [
            '<clipPath id="c"><rect x="abc" width="6" height="6"/></clipPath><rect width="10" height="10" clip-path="url(#c)"/>',
            '<clipPath id="c"><rect x="0" width="6" height="6"/></clipPath><rect width="10" height="10" clip-path="url(#c)"/>',
        ],
    ])('%s: as the initial value, without unsupported-attribute', (body, initial) => {
        const { xml, warnings } = convert(svg(body), { optimize });
        const expected = convert(svg(initial), { optimize });
        expect(warnings).toEqual(expected.warnings);
        expect(warnings.map((w) => w.code)).not.toContain('unsupported-attribute');
        expect(strictError(svg(body), optimize)).toEqual(strictError(svg(initial), optimize));
        expect(compareSvgs(svg(initial), vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });

    it('<rect x="10abc">: strict passes', () => {
        expect(strictError(svg('<rect x="10abc" width="5" height="5"/>'), optimize)).toBeNull();
    });

    it('<rect x="1ex">: a valid length the converter cannot resolve keeps its warning', () => {
        expect(messages('<rect x="1ex" width="5" height="5"/>')).toEqual([
            'x="1ex" on <rect> is not a length the converter can resolve (ex, ch, calc()…); 0 is used.',
        ]);
    });

    it.each(['1ex', '2ch', '1vw', '3Q', 'calc(1px + 2px)', 'var(--r)'])(
        '<ellipse rx="%s">: valid but unresolvable, the message keeps naming ex / ch / calc()',
        (value) => {
            expect(messages(`<ellipse cx="12" cy="12" rx="${value}" ry="10"/>`)).toEqual([
                `rx="${value}" on <ellipse> is not a length the converter can resolve (ex, ch, calc()…); auto is used.`,
            ]);
        },
    );
});

describe.each([true, false])(
    'a var() declaration inherited by several paths is reported once (optimize: %s)',
    (optimize) => {
        const RECTS =
            '<rect width="4" height="4"/><rect x="8" width="4" height="4"/><rect x="16" width="4" height="4"/>';
        const warningsOf = (body: string): [string, string][] =>
            convert(svg(body), { optimize }).warnings.map((w) => [w.code, w.message]);

        it.each([
            [
                'fill-opacity',
                '<g style="fill-opacity:var(--o)">',
                'unsupported-style',
                'fill-opacity: var(--o) cannot be resolved',
            ],
            ['fill', '<g style="fill:var(--c)">', 'unsupported-paint', 'fill="var(--c)" is not a color'],
            [
                'stroke-width',
                '<g stroke="red" style="stroke-width:var(--w)">',
                'unsupported-style',
                'stroke-width: var(--w) cannot be resolved',
            ],
            [
                'color (currentColor fill)',
                '<g fill="currentColor" style="color:var(--c)">',
                'unsupported-paint',
                'color="var(--c)" cannot be resolved',
            ],
        ])('%s on a group of three paths: one warning', (_name, group, code, message) => {
            expect(warningsOf(`${group}${RECTS}</g>`)).toEqual([[code, expect.stringContaining(message)]]);
        });

        it('two different var() declarations stay two warnings', () => {
            expect(
                warningsOf(
                    `<g style="fill-opacity:var(--a)">${RECTS}</g><g style="fill-opacity:var(--b)">${RECTS}</g>`,
                ),
            ).toEqual([
                ['unsupported-style', expect.stringContaining('fill-opacity: var(--a)')],
                ['unsupported-style', expect.stringContaining('fill-opacity: var(--b)')],
            ]);
        });
    },
);

// T-124 / T-145: Chrome and Firefox paint the fallback (nothing without one) of a paint server in
// another document that cannot be loaded (and a valid one when it can: a `data:` URL with a
// gradient), so the fallback is lossy.
describe.each([true, false])('a non-local url() paint (optimize: %s)', (optimize) => {
    const external = (property: string, url: string): [string, string] => [
        'unsupported-paint',
        `${property}="url(${url})" points at a paint server in another document, which the converter does not load; its fallback color red is used.`,
    ];
    const warningsOf = (source: string): [string, string][] =>
        convert(source, { optimize }).warnings.map((w) => [w.code, w.message]);
    const reference = svg('<rect width="10" height="10" fill="red"/>');

    it.each([
        ['attribute, relative file', '<rect width="10" height="10" fill="url(other.svg#g) red"/>', 'other.svg#g'],
        [
            'attribute, quoted data: URL',
            `<rect width="10" height="10" fill="url('data:image/svg+xml,%3Csvg/%3E#g') red"/>`,
            'data:image/svg+xml,%3Csvg/%3E#g',
        ],
        [
            'style, data: URL with a ";"',
            `<rect width="10" height="10" style="fill:url('data:image/svg+xml;utf8,%3Csvg/%3E#g') red"/>`,
            'data:image/svg+xml;utf8,%3Csvg/%3E#g',
        ],
    ])('fill (%s): the fallback color, reported', (_, body, url) => {
        const source = svg(body);
        const { xml } = convert(source, { optimize });
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        // svgo lowercases the percent-escapes of a data: URL.
        expect(warningsOf(source).map(([c, m]) => [c, m.toLowerCase()])).toEqual([
            external('fill', url).map((s) => s.toLowerCase()),
        ]);
        expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        expect(strictError(source, optimize)?.code).toBe('unsupported-paint');
    });

    it('stroke: the fallback color, reported', () => {
        const source = svg('<rect width="10" height="10" fill="none" stroke="url(other.svg#g) red"/>');
        const { xml } = convert(source, { optimize });
        expect(xml).toContain('android:strokeColor="#FFFF0000"');
        expect(warningsOf(source)).toEqual([external('stroke', 'other.svg#g')]);
    });

    it('reported once for a declaration inherited by several paths', () => {
        const source = svg(
            '<g fill="url(other.svg#g) red"><rect width="4" height="4"/><rect x="8" width="4" height="4"/></g>',
        );
        expect(warningsOf(source)).toEqual([external('fill', 'other.svg#g')]);
    });

    // T-145: without fallback, Chrome and Firefox paint nothing (as for a <pattern>, T-63).
    const unpainted = (property: string, url: string): [string, string] => [
        'unsupported-paint',
        `${property}="url(${url})" points at a paint server in another document, which the converter does not load; the ${property} is not painted.`,
    ];

    it.each([
        ['fill', '<rect width="10" height="10" fill="url(other.svg#g)"/>'],
        ['stroke', '<rect width="10" height="10" fill="none" stroke="url(other.svg#g)" stroke-width="2"/>'],
    ])('%s without fallback: nothing painted, reported, rejected by strict', (property, body) => {
        const source = svg(body);
        expect(convert(source, { optimize }).xml).not.toContain('<path');
        expect(warningsOf(source)).toEqual([unpainted(property, 'other.svg#g')]);
        expect(strictError(source, optimize)?.code).toBe('unsupported-paint');
    });

    it('fill without fallback over a stroke: the stroke only', () => {
        const source = svg('<rect width="10" height="10" fill="url(other.svg#g)" stroke="#00f"/>');
        const { xml } = convert(source, { optimize });
        expect(xml).not.toContain('fillColor');
        expect(xml).toContain('android:strokeColor="#FF0000FF"');
        expect(warningsOf(source)).toEqual([unpainted('fill', 'other.svg#g')]);
    });

    it('stroke without fallback under a fill: the fill only', () => {
        const source = svg('<rect width="10" height="10" fill="#f00" stroke="url(other.svg#g)"/>');
        const { xml } = convert(source, { optimize });
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).not.toContain('strokeColor');
        expect(warningsOf(source)).toEqual([unpainted('stroke', 'other.svg#g')]);
    });

    it('without fallback, inherited by several paths: reported once', () => {
        const source = svg(
            '<g fill="url(other.svg#g)" stroke="#000"><rect width="4" height="4"/><rect x="8" width="4" height="4"/></g>',
        );
        expect(warningsOf(source)).toEqual([unpainted('fill', 'other.svg#g')]);
    });

    it('a local url(#absent) with a fallback stays silent', () => {
        expect(warningsOf(svg('<rect width="10" height="10" fill="url(#absent) red"/>'))).toEqual([]);
    });
});

// T-129 (also): a declaration inherited by several children is reported once, as svgo may merge them.
describe.each([true, false])('paint warnings repeated per child are reported once (optimize: %s)', (optimize) => {
    const codes = (body: string): string[] => convert(svg(body), { optimize }).warnings.map((w) => w.code);

    it('<g fill="url(#missing)"> with 3 children: one missing-gradient', () => {
        expect(
            codes(
                '<g fill="url(#missing)" stroke="#000"><rect width="4" height="4"/><rect x="8" width="4" height="4"/><rect x="16" width="4" height="4"/></g>',
            ),
        ).toEqual(['missing-gradient']);
    });

    it('<g paint-order="stroke"> with 2 children: one unsupported-attribute', () => {
        expect(
            codes(
                '<g paint-order="stroke" fill="#f00" stroke="#000" stroke-width="2"><rect width="4" height="4"/><circle cx="16" cy="4" r="3"/></g>',
            ),
        ).toEqual(['unsupported-attribute']);
    });
});

// T-139: a <pattern> paint inherited by several children is reported once per message, as svgo may merge them.
describe.each([true, false])('<pattern> paint warnings under a <g> are reported once (optimize: %s)', (optimize) => {
    const pattern = '<pattern id="p" width="2" height="2"><rect width="1" height="1" fill="#f00"/></pattern>';
    const children =
        '<rect width="4" height="4"/><rect x="8" width="4" height="4"/><rect x="16" width="4" height="4"/>';
    const messages = (g: string): string[] =>
        convert(svg(`${pattern}<g ${g}>${children}</g>`), { optimize }).warnings.map((w) => w.message);

    it.each([
        ['fill="url(#p)" stroke="#000"', /^<pattern> fill "p" .*the fill is not painted\.$/],
        ['fill="url(#p) #0f0"', /^<pattern> fill "p" .*using its fallback color\.$/],
        ['fill="none" stroke="url(#p)"', /^Pattern strokes .*stroke dropped\.$/],
        ['fill="#0f0" stroke="url(#p) #00f"', /^Pattern strokes .*using the fallback color\.$/],
    ])('%s: one warning', (g, message) => {
        const found = messages(g);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(message);
    });

    it('fill and stroke <pattern>: one warning per message', () => {
        const found = messages('fill="url(#p) #0f0" stroke="url(#p)"');
        expect(found).toHaveLength(2);
        expect(found.some((m) => m.startsWith('<pattern> fill'))).toBe(true);
        expect(found.some((m) => m.startsWith('Pattern strokes'))).toBe(true);
    });
});

// T-142: the stroke and opacity warnings of a declaration inherited by several children are reported
// once, as svgo may merge those children.
describe.each([true, false])('stroke and opacity warnings under a <g> are reported once (optimize: %s)', (optimize) => {
    const children =
        '<rect width="4" height="4"/><rect x="8" width="4" height="4"/><rect x="16" width="4" height="4"/>';
    const warningsOf = (g: string): [string, string][] =>
        convert(svg(`<g ${g}>${children}</g>`), { optimize }).warnings.map((w) => [w.code, w.message]);

    it.each([
        ['fill="none" stroke="#000" stroke-linejoin="arcs"', 'unsupported-attribute', 'stroke-linejoin="arcs"'],
        [
            'fill="none" stroke="#000" stroke-linejoin="miter-clip"',
            'unsupported-attribute',
            'stroke-linejoin="miter-clip"',
        ],
        ['fill="none" stroke="#000" stroke-dasharray="calc(1px)"', 'unsupported-stroke-dasharray', 'calc(1px)'],
        // Children apart: no group-level overlap warning, only the per-path fill + stroke one.
        ['opacity="0.5" fill="#f00" stroke="#000"', 'opacity-approximated', 'fillAlpha/strokeAlpha'],
    ])('%s: one warning', (g, code, message) => {
        expect(warningsOf(g)).toEqual([[code, expect.stringContaining(message)]]);
    });

    it('two different joins stay two warnings', () => {
        const source = svg(
            `<g fill="none" stroke="#000"><rect width="4" height="4" stroke-linejoin="arcs"/><rect x="8" width="4" height="4" stroke-linejoin="miter-clip"/></g>`,
        );
        expect(convert(source, { optimize }).warnings.map((w) => w.message)).toEqual([
            expect.stringContaining('"arcs"'),
            expect.stringContaining('"miter-clip"'),
        ]);
    });
});

// T-166: gradient-under-skew was deduplicated per path only, vector-effect not at all.
describe.each([true, false])('skew and vector-effect warnings are reported once (optimize: %s)', (optimize) => {
    const codesOf = (body: string): [string, string][] =>
        convert(svg(body), { optimize }).warnings.map((w) => [w.code, w.message]);
    const gradient =
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>';

    it('three gradient-filled children of a skewed <g>: one gradient-under-skew', () => {
        const children =
            '<rect width="5" height="5" fill="url(#g)"/><rect x="6" width="5" height="5" fill="url(#g)"/><circle cx="15" cy="15" r="3" fill="url(#g)"/>';
        expect(codesOf(`${gradient}<g transform="skewX(10)">${children}</g>`)).toEqual([
            ['gradient-under-skew', expect.any(String)],
        ]);
    });

    it('an element with vector-effect instanced by three <use>: one warning', () => {
        const body =
            '<defs><path id="p" d="M0 0L5 5" stroke="#000" vector-effect="non-scaling-stroke"/></defs><use href="#p"/><use href="#p" x="5"/><use href="#p" x="10"/>';
        expect(codesOf(body)).toEqual([['unsupported-attribute', expect.stringContaining('vector-effect')]]);
    });

    it('two different vector-effect values stay two warnings', () => {
        const body =
            '<path d="M0 0L5 5" stroke="#000" vector-effect="non-scaling-stroke"/><path d="M5 0L9 5" stroke="#000" vector-effect="non-scaling-size"/>';
        expect(codesOf(body).map(([, m]) => m)).toEqual([
            expect.stringContaining('"non-scaling-stroke"'),
            expect.stringContaining('"non-scaling-size"'),
        ]);
    });
});

describe('a fill without area beside a painted stroke is not emitted (T-157)', () => {
    const paths = (xml: string): string[] => xml.match(/<path[\s\S]*?\/>/g) ?? [];
    const both = (input: string): { xml: string; warnings: Warning[] }[] =>
        [true, false].map((optimize) => convert(input, { optimize }));

    it.each([
        ['<line x1="1" y1="1" x2="20" y2="20" stroke="red"/>', 'a <line>'],
        ['<line x1="1" y1="1" x2="20" y2="20" stroke="red" stroke-dasharray="2"/>', 'a dashed <line>'],
        ['<polyline points="1 1 20 1 5 1" stroke="red"/>', 'a flat <polyline>'],
        ['<path d="M1 1L20 20M1 5H20" stroke="red"/>', 'flat subpaths on different lines'],
    ])('%s: one stroke path, identical in both modes', (body) => {
        const [opt, raw] = both(svg(body));
        // svgo rewrites the path data; everything else is identical.
        const noData = (xml: string): string => xml.replace(/pathData="[^"]*"/g, 'pathData=""');
        expect(noData(raw!.xml)).toBe(noData(opt!.xml));
        expect(paths(raw!.xml)).toHaveLength(1);
        expect(raw!.xml).not.toContain('fillColor');
        expect(raw!.xml).toContain('strokeColor="#FFFF0000"');
        expect(raw!.warnings).toEqual([]);
        expect(opt!.warnings).toEqual([]);
    });

    it.each([true, false])('reports nothing about the unused fill (optimize: %s)', (optimize) => {
        const input = svg(
            '<defs><pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern></defs>' +
                '<line x1="1" y1="1" x2="20" y2="20" fill="url(#p)" stroke="red" opacity="0.5"/>',
        );
        expect(strictError(input, optimize)).toBeNull();
        expect(convert(input, { optimize }).xml).not.toContain('fillColor');
    });

    it.each([
        ['<polyline points="1 1 20 1 20 20" stroke="red"/>', 'an open subpath that is not flat'],
        ['<path d="M0 0L10 10L0 10L10 0Z" stroke="red"/>', 'a closed figure-eight (signed area 0)'],
    ])('%s: keeps its fill (%s)', (body) => {
        for (const { xml } of both(svg(body))) {
            expect(paths(xml)).toHaveLength(1);
            expect(xml).toContain('fillColor="#FF000000"');
            expect(xml).toContain('strokeColor="#FFFF0000"');
        }
    });

    // T-184: it paints nothing (a browser draws nothing for it either), so nothing is written, without a
    // warning, in both modes; tabler's filled/chess-bishop.svg has one (`M12 5v1`).
    it.each(['<path d="M0 0h5"/>', '<path d="M12 5v1"/>', '<line x1="0" y1="0" x2="5" y2="5"/>'])(
        'a flat %s with only a fill is not written',
        (body) => {
            for (const optimize of [true, false]) {
                const { xml, warnings } = convert(svg(body + '<rect width="4" height="4"/>'), { optimize });
                expect(paths(xml), `optimize: ${optimize}`).toHaveLength(1);
                expect(warnings).toEqual([]);
            }
        },
    );
});
