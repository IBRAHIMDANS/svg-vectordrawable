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

    it('context-fill is reported (strict rejects it) instead of silently dropping the shape', () => {
        const source = repro('wpt-paint-context-fill.svg');
        const { warnings } = convert(source, { optimize });
        expect(warnings.map((w) => [w.code, w.message])).toEqual([
            ['unsupported-paint', expect.stringContaining('fill="context-fill"')],
        ]);
        expect(strictError(source, optimize)?.code).toBe('unsupported-paint');
    });
});

describe('unparseable paints', () => {
    const run = (body: string, options = {}): { xml: string; codes: string[]; messages: string[] } => {
        const { xml, warnings } = convert(svg(body), { optimize: false, ...options });
        return { xml, codes: warnings.map((w) => w.code), messages: warnings.map((w) => w.message) };
    };

    it.each(['var(--brand)', 'color-mix(in srgb, red, blue)', 'rgb(from red r g b)', 'light-dark(red, blue)', 'redd'])(
        'fill="%s" warns and paints the initial black fill',
        (value) => {
            const { xml, codes } = run(`<rect width="10" height="10" fill="${value}"/>`);
            expect(codes).toEqual(['unsupported-paint']);
            expect(xml).toContain('android:fillColor="#FF000000"');
        },
    );

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
    const notPainted = (property: string): [string, string] => [
        'missing-gradient',
        expect.stringMatching(
            // svgo (optimize: true) may rename the id.
            new RegExp(
                `^${property}="url\\(#\\w+\\)" points at a gradient that is not a valid paint server .* the ${property} is not painted\\.$`,
            ),
        ) as string,
    ];

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
        const { xml, warnings } = convert(
            svg('<defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)"/>'),
            { optimize },
        );
        expect(warnings.map((w) => [w.code, w.message])).toEqual([notPainted('fill')]);
        expect(xml).not.toContain('<path');
    });

    it('uses the fallback color of an invalid gradient, without warning', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#g) #00f" stroke="url(#g) #0f0"/>');
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:fillColor="#FF0000FF"');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
    });

    it('keeps the black fill and its message for an unknown reference', () => {
        const { xml, warnings } = run('<rect width="10" height="10" fill="url(#nope)" stroke="url(#nope)"/>');
        expect(warnings).toEqual([
            ['missing-gradient', 'Path references unknown gradient "nope"; using black.'],
            ['missing-gradient', 'Stroke references unknown paint "nope"; stroke dropped.'],
        ]);
        expect(xml).toContain('android:fillColor="#FF000000"');
        expect(xml).not.toContain('strokeColor');
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
