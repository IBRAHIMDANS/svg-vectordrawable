import { existsSync, readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { convert, ConversionError } from '../src/index.js';
import { textLayout as browserTextLayout } from '../src/text-browser.js';
import type { ConvertOptions } from '../src/types.js';
import { compareRasters, DEFAULT_MAX_MISMATCH, RENDER_WIDTH, type Raster } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

// Quicksand (SIL OFL 1.1, see test/fixtures-fonts/OFL.txt): proportional, with GPOS kerning.
const FONT = new URL('./fixtures-fonts/Quicksand-Regular.ttf', import.meta.url).pathname;
const FONTS = { Quicksand: FONT };

const svg = (body: string, viewBox = '0 0 100 40'): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

/**
 * resvg render with the fixture font loaded. test/visual/compare.ts renders without fonts (its
 * `renderSvg` sets no font files), hence this variant; the comparison itself is the shared one.
 */
function render(source: string): Raster {
    const image = new Resvg(source, {
        fitTo: { mode: 'width', value: RENDER_WIDTH },
        font: { loadSystemFonts: false, fontFiles: [FONT] },
    }).render();
    return { width: image.width, height: image.height, pixels: new Uint8Array(image.pixels) };
}

const UNCHANGED = '<text> cannot be represented in a VectorDrawable; skipped.';

const textWarnings = (source: string, options: ConvertOptions = { fonts: FONTS }): string[] =>
    convert(source, options)
        .warnings.filter((w) => w.code === 'unsupported-element')
        .map((w) => w.message);

describe('<text> with the fonts option', () => {
    // First: nothing has loaded opentype.js yet in this file's module graph.
    describe('loads opentype.js lazily', () => {
        afterEach(() => {
            vi.doUnmock('node:module');
            vi.resetModules();
        });

        /** Ids required through createRequire while running `run` on a fresh module graph. */
        async function requiredIds(run: (c: typeof convert) => void): Promise<string[]> {
            vi.resetModules();
            const ids: string[] = [];
            vi.doMock('node:module', async (importOriginal) => {
                const real = await importOriginal<typeof import('node:module')>();
                return {
                    ...real,
                    createRequire: (url: string | URL) => {
                        const req = real.createRequire(url);
                        return (id: string) => (ids.push(id), req(id));
                    },
                };
            });
            run((await import('../src/index.js')).convert);
            return ids;
        }

        const TEXT = svg('<text x="5" y="28" font-family="Quicksand" font-size="20">Hi</text>');

        it('not without the fonts option, nor without a <text> to draw', async () => {
            expect(await requiredIds((c) => c(TEXT))).toEqual([]);
            expect(await requiredIds((c) => c(svg('<rect width="5" height="5"/>'), { fonts: FONTS }))).toEqual([]);
            // No font for the family: reported before any loading.
            expect(await requiredIds((c) => c(TEXT, { fonts: { Other: FONT } }))).toEqual([]);
        });

        it('on the first <text> drawn', async () => {
            expect(await requiredIds((c) => c(TEXT, { fonts: FONTS }))).toEqual(['opentype.js']);
        });

        it('without opentype.js installed, every <text> is reported with how to install it', async () => {
            vi.resetModules();
            vi.doMock('node:module', async (importOriginal) => ({
                ...(await importOriginal<typeof import('node:module')>()),
                createRequire: () => (id: string) => {
                    throw Object.assign(new Error(`Cannot find module '${id}'\nRequire stack:\n- x`), {
                        code: 'MODULE_NOT_FOUND',
                    });
                },
            }));
            const fresh = (await import('../src/index.js')).convert;
            expect(fresh(TEXT, { fonts: FONTS }).warnings.map((w) => [w.code, w.message])).toEqual([
                [
                    'unsupported-element',
                    '<text> cannot be represented in a VectorDrawable (the fonts option needs opentype.js, which is not installed: npm install opentype.js); skipped.',
                ],
            ]);
        });
    });

    describe('renders like the SVG with the same font (resvg)', () => {
        const CASES: Record<string, string> = {
            'plain text, kerning and ligatures': svg(
                '<text x="5" y="28" font-family="Quicksand" font-size="20">AVAWfi Hello</text>',
            ),
            'text-anchor middle, fill and stroke': svg(
                '<text x="50" y="28" font-family="Quicksand" font-size="20" text-anchor="middle" fill="#c00" stroke="#00c" stroke-width="0.5">Ty Vo</text>',
            ),
            'text-anchor end, transform, collapsed whitespace': svg(
                '<text x="95" y="28" font-family="\'Quicksand\', sans-serif" font-size="20" text-anchor="end" transform="rotate(5 50 20)">  a   b\n c </text>',
            ),
            'properties inherited from a group, percentage position': svg(
                '<g font-family="quicksand" font-size="18px" fill="teal" opacity="0.8"><text x="10%" y="70%">Group</text></g>',
            ),
            'a leading positioned <tspan> (Figma export), preserved spaces': svg(
                '<text fill="black" xml:space="preserve" style="white-space: pre" font-family="Quicksand" font-size="16" letter-spacing="0em"><tspan x="2" y="20">  a  b</tspan></text>',
            ),
            'plain <tspan>s within the line, under a skewed group (baked)': svg(
                '<g transform="skewX(10)"><text x="2" y="25" font-family="Quicksand" font-size="14">one <tspan>two</tspan> three</text></g>',
            ),
            // svgo would dissolve the group (collapseGroups) or hoist the children's size over its
            // own (moveElemsAttrsToGroup): the relative size would lose its reference.
            'an em font-size under a group font-size (svgo keeps the group)': svg(
                '<g font-family="Quicksand" font-size="10"><text x="2" y="30" font-size="2em">em size</text></g>',
            ),
            'percentage font-sizes on every child of a group': svg(
                '<g font-family="Quicksand" font-size="10"><text x="2" y="15" font-size="150%">one</text><text x="2" y="35" font-size="150%">two</text></g>',
            ),
            'a clip-path on the text': svg(
                '<clipPath id="c"><rect width="40" height="40"/></clipPath><text clip-path="url(#c)" x="5" y="28" font-family="Quicksand" font-size="20">Clipped</text>',
            ),
        };
        for (const [name, source] of Object.entries(CASES))
            for (const optimize of [true, false])
                it(`${name} (optimize: ${optimize})`, () => {
                    const result = convert(source, { optimize, fonts: FONTS });
                    // The skewed group is baked into the outlines (group-skew, info), as for any shape.
                    expect(result.warnings.filter((w) => w.code !== 'group-skew')).toEqual([]);
                    const diff = compareRasters(render(source), render(vdToSvg(result.xml)));
                    expect(diff.sizeMismatch).toBeNull();
                    expect(diff.inked).toBeGreaterThan(100);
                    expect(diff.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
                });

        it('the comparison detects a wrong layout (a shifted glyph run)', () => {
            const source = CASES['plain text, kerning and ligatures']!;
            const shifted = source.replace('x="5"', 'x="6"');
            const xml = convert(shifted, { fonts: FONTS }).xml;
            expect(compareRasters(render(source), render(vdToSvg(xml))).mismatch).toBeGreaterThan(0.05);
        });

        it('takes the font as bytes too, the family matched case-insensitively', () => {
            const source = CASES['plain text, kerning and ligatures']!;
            const bytes = new Uint8Array(readFileSync(FONT));
            expect(convert(source, { fonts: { '  QUICKSAND ': bytes } }).xml).toBe(
                convert(source, { fonts: FONTS }).xml,
            );
        });

        it('a bold or italic text uses its own key', () => {
            const bold = svg('<text x="5" y="28" font-family="Quicksand" font-weight="bold">Hi</text>');
            expect(textWarnings(bold)).toEqual([
                '<text> cannot be represented in a VectorDrawable (no font for font-family Quicksand weight 700 in the fonts option); skipped.',
            ]);
            // Any file can stand for a variant: here the regular face, to check the lookup only.
            for (const key of ['Quicksand bold', 'quicksand 700'])
                expect(textWarnings(bold, { fonts: { [key]: FONT } })).toEqual([]);
            const italic = svg('<text x="5" y="28" font-family="Quicksand" font-style="italic">Hi</text>');
            expect(textWarnings(italic, { fonts: { 'Quicksand italic': FONT } })).toEqual([]);
        });

        it('a <tspan> restating an inherited value is drawn as plain, in both modes (svgo drops it)', () => {
            const cases: [string, string][] = [
                ['fill="red"', '<tspan fill="red">'],
                ['fill="red"', '<tspan fill="#f00">'],
                ['font-size="20"', '<tspan font-size="20px">'],
                ['', '<tspan fill="#000">'],
                ['fill="red"', '<tspan style="fill:red">'],
                ['fill="red" font-size="20"', '<tspan id="b" style="font-size: 20" fill="red">'],
            ];
            for (const [textAttrs, tspan] of cases) {
                const text = (inner: string): string =>
                    svg(`<text x="5" y="28" font-family="Quicksand" ${textAttrs}>a${inner}b</tspan> c</text>`);
                const expected = convert(text('<tspan>'), { fonts: FONTS, optimize: false }).xml;
                expect(expected).toContain('<path');
                for (const optimize of [true, false]) {
                    const result = convert(text(tspan), { fonts: FONTS, optimize });
                    expect(result.warnings, `${tspan}, optimize: ${optimize}`).toEqual([]);
                    expect(result.xml, `${tspan}, optimize: ${optimize}`).toBe(expected);
                }
            }
        });

        // One test per <tspan>: each converts twice with the font, too slow for one 5 s timeout under load.
        describe('a <tspan> declaring a non-inherited property at its initial value is drawn as plain, in both modes', () => {
            const text = (tspan: string): string =>
                svg(`<text x="5" y="28" font-family="Quicksand">a${tspan}b</tspan> c</text>`);
            let expected: string;
            beforeAll(() => {
                expected = convert(text('<tspan>'), { fonts: FONTS, optimize: false }).xml;
            });

            it('draws the plain <tspan> reference', () => {
                expect(expected).toContain('<path');
            });

            it.each([
                '<tspan opacity="1">',
                '<tspan opacity="1.0">',
                '<tspan id="b" opacity="1">', // svgo keeps a default on an element with an id
                '<tspan style="opacity:1">',
                '<tspan style="fill:#000; baseline-shift: baseline">',
                '<tspan baseline-shift="baseline">',
                '<tspan text-decoration="none">',
                '<tspan unicode-bidi="normal">',
                '<tspan alignment-baseline="baseline">',
                '<tspan alignment-baseline="auto">',
                '<tspan display="inline">',
                '<tspan clip="auto">',
                '<tspan clip-path="none">',
                '<tspan mask="none">',
                '<tspan filter="none">',
                '<tspan mix-blend-mode="normal">',
                '<tspan isolation="auto">',
                '<tspan vector-effect="none">',
                '<tspan text-overflow="clip">',
                '<tspan stop-color="black">',
                '<tspan stop-opacity="1">',
                // Inherited, but ignored by the glyph outlines (T-104 / T-103).
                '<tspan clip-rule="nonzero">',
                '<tspan color-interpolation="sRGB">',
                '<tspan color-rendering="auto">',
                '<tspan shape-rendering="auto">',
                '<tspan text-rendering="auto">',
                '<tspan image-rendering="auto">',
                '<tspan kerning="auto">',
                '<tspan glyph-orientation-horizontal="0deg">',
                '<tspan glyph-orientation-vertical="auto">',
                '<tspan marker-start="none">',
                '<tspan marker-mid="none">',
                '<tspan marker-end="none">',
                '<tspan style="marker: none">',
            ])('%s', (tspan) => {
                for (const optimize of [true, false]) {
                    const result = convert(text(tspan), { fonts: FONTS, optimize });
                    expect(result.warnings, `optimize: ${optimize}`).toEqual([]);
                    expect(result.xml, `optimize: ${optimize}`).toBe(expected);
                }
            });
        });

        it('a <tspan> restating an inherited property at its initial value, the <text> setting none, is drawn as plain, in both modes', () => {
            const text = (tspan: string): string =>
                svg(`<text x="5" y="28" font-family="Quicksand">a${tspan}b</tspan> c</text>`);
            const expected = convert(text('<tspan>'), { fonts: FONTS, optimize: false }).xml;
            expect(expected).toContain('<path');
            const tspans = [
                '<tspan font-weight="normal">',
                '<tspan font-weight="400">',
                '<tspan style="font-weight: normal">',
                '<tspan font-style="normal">',
                '<tspan font-variant="normal">',
                '<tspan text-anchor="start">',
                '<tspan letter-spacing="normal">',
                '<tspan letter-spacing="0">',
                '<tspan word-spacing="normal">',
                '<tspan stroke-width="1">',
                '<tspan stroke-width="1px">',
                '<tspan stroke-linecap="butt">',
                '<tspan stroke-linejoin="miter">',
                '<tspan stroke-miterlimit="4">',
                '<tspan stroke-dasharray="none">',
                '<tspan fill-rule="nonzero">',
                '<tspan visibility="visible">',
            ];
            for (const tspan of tspans)
                for (const optimize of [true, false]) {
                    const result = convert(text(tspan), { fonts: FONTS, optimize });
                    expect(result.warnings, `${tspan}, optimize: ${optimize}`).toEqual([]);
                    expect(result.xml, `${tspan}, optimize: ${optimize}`).toBe(expected);
                }
        });

        it('a <tspan> with display="none" is skipped, the remaining text drawn, in both modes', () => {
            const expected = convert(svg('<text x="5" y="28" font-family="Quicksand">a c</text>'), {
                fonts: FONTS,
                optimize: false,
            }).xml;
            expect(expected).toContain('<path');
            for (const tspan of [
                '<tspan display="none">',
                '<tspan style="display:none">',
                '<tspan display="none" fill="red" dx="3">',
            ])
                for (const optimize of [true, false]) {
                    const source = svg(`<text x="5" y="28" font-family="Quicksand">a${tspan}b</tspan> c</text>`);
                    const result = convert(source, { fonts: FONTS, optimize });
                    expect(result.warnings, `${tspan}, optimize: ${optimize}`).toEqual([]);
                    expect(result.xml, `${tspan}, optimize: ${optimize}`).toBe(expected);
                }
        });

        it('a <tspan> with a blend mode or an isolation is reported alike in both modes (svgo keeps it), and rejected in strict', () => {
            for (const [tspan, prop] of [
                ['<tspan mix-blend-mode="multiply">', 'mix-blend-mode'],
                ['<tspan isolation="isolate">', 'isolation'],
                ['<tspan id="b" mix-blend-mode="screen">', 'mix-blend-mode'],
            ]) {
                const source = svg(`<text x="5" y="28" font-family="Quicksand">a${tspan}b</tspan> c</text>`);
                const reason = `<text> cannot be represented in a VectorDrawable (<tspan> with its own ${prop} is not supported); skipped.`;
                for (const optimize of [true, false]) {
                    expect(textWarnings(source, { fonts: FONTS, optimize }), `${tspan}, optimize: ${optimize}`).toEqual(
                        [reason],
                    );
                    expect(() => convert(source, { fonts: FONTS, optimize, strict: true })).toThrow(ConversionError);
                }
            }
        });

        it('draws nothing, silently, for whitespace-only text or font-size 0', () => {
            for (const body of [
                '<text x="5" y="28" font-family="Quicksand">   </text>',
                '<text x="5" y="28" font-family="Quicksand" font-size="0">Hi</text>',
            ]) {
                const result = convert(svg(body), { fonts: FONTS, optimize: false });
                expect(result.warnings).toEqual([]);
                expect(result.xml).not.toContain('<path');
            }
        });
    });

    describe('everything else keeps the unsupported-element warning', () => {
        it('without the fonts option: the message is unchanged', () => {
            const source = svg('<text x="5" y="28" font-family="Quicksand">Hi</text>');
            for (const optimize of [true, false]) expect(textWarnings(source, { optimize })).toEqual([UNCHANGED]);
        });

        const reported: [string, string, string][] = [
            [
                'a missing font',
                '<text font-family="Inter, sans-serif">Hi</text>',
                'no font for font-family Inter, sans-serif in the fonts option',
            ],
            ['no font-family', '<text>Hi</text>', 'no font-family is set'],
            [
                'a <textPath>',
                '<path id="p" d="M0 20H100"/><text font-family="Quicksand"><textPath href="#p">Hi</textPath></text>',
                '<textPath> in <text> is not supported',
            ],
            [
                'positioned <tspan>s (multi-line)',
                '<text font-family="Quicksand"><tspan x="0" y="10">a</tspan><tspan x="0" y="30">b</tspan></text>',
                'positioned <tspan>s (multi-line text) are not supported',
            ],
            [
                'a <tspan> with dx',
                '<text font-family="Quicksand">a<tspan dx="3">b</tspan></text>',
                '<tspan> with its own dx is not supported',
            ],
            [
                'a styled <tspan>',
                '<text font-family="Quicksand">a<tspan fill="red">b</tspan></text>',
                '<tspan> with its own fill is not supported',
            ],
            [
                'a <tspan> fill other than the inherited one',
                '<text fill="red" font-family="Quicksand">a<tspan fill="blue">b</tspan></text>',
                '<tspan> with its own fill is not supported',
            ],
            [
                'a <tspan> style fill other than the inherited one',
                '<text fill="red" font-family="Quicksand">a<tspan style="fill:blue">b</tspan></text>',
                '<tspan> with its own style is not supported',
            ],
            [
                'a <tspan> font-size other than the inherited one',
                '<text font-size="20" font-family="Quicksand">a<tspan font-size="12">b</tspan></text>',
                '<tspan> with its own font-size is not supported',
            ],
            [
                'a <tspan> font-weight other than the initial one, the <text> setting none',
                '<text font-family="Quicksand">a<tspan font-weight="700">b</tspan></text>',
                '<tspan> with its own font-weight is not supported',
            ],
            [
                'a <tspan> stroke-width other than the initial one, the <text> setting none',
                '<text font-family="Quicksand">a<tspan stroke-width="2">b</tspan></text>',
                '<tspan> with its own stroke-width is not supported',
            ],
            [
                'a <tspan> with a non-inherited property',
                '<text font-family="Quicksand">a<tspan opacity="0.5">b</tspan></text>',
                '<tspan> with its own opacity is not supported',
            ],
            [
                'a <tspan> with a non-inherited property in style',
                '<text font-family="Quicksand">a<tspan style="opacity:0.5">b</tspan></text>',
                '<tspan> with its own opacity is not supported',
            ],
            [
                'a <tspan> baseline shift',
                '<text font-family="Quicksand">a<tspan baseline-shift="super">b</tspan></text>',
                '<tspan> with its own baseline-shift is not supported',
            ],
            [
                'a <tspan> underline',
                '<text font-family="Quicksand">a<tspan text-decoration="underline">b</tspan></text>',
                '<tspan> with its own text-decoration is not supported',
            ],
            [
                'per-character x',
                '<text x="1 5 9" font-family="Quicksand">abc</text>',
                'per-character x / y positions are not supported',
            ],
            ['rotate', '<text rotate="10" font-family="Quicksand">abc</text>', 'rotate is not supported'],
            ['textLength', '<text textLength="50" font-family="Quicksand">abc</text>', 'textLength is not supported'],
            [
                'letter-spacing',
                '<text letter-spacing="2" font-family="Quicksand">abc</text>',
                'letter-spacing: 2 is not supported',
            ],
            [
                'vertical text',
                '<text writing-mode="vertical-rl" font-family="Quicksand">abc</text>',
                'writing-mode: vertical-rl is not supported',
            ],
            [
                'a baseline shift',
                '<text dominant-baseline="middle" font-family="Quicksand">abc</text>',
                'dominant-baseline: middle is not supported',
            ],
            [
                'an underline',
                '<text text-decoration="underline" font-family="Quicksand">abc</text>',
                'text-decoration: underline is not supported',
            ],
            [
                'the font shorthand (on an ancestor)',
                '<g style="font: 12px Quicksand"><text font-family="Quicksand">abc</text></g>',
                'font: 12px Quicksand is not supported',
            ],
            [
                'a relative font-weight',
                '<text font-weight="bolder" font-family="Quicksand">abc</text>',
                'font-weight: bolder is not supported',
            ],
            [
                'multi-line preserved text',
                '<text style="white-space:pre" font-family="Quicksand">a\nb</text>',
                'multi-line text is not supported',
            ],
            [
                'right-to-left text',
                '<text font-family="Quicksand">שלום</text>',
                'text needing complex shaping is not supported',
            ],
            [
                'a missing glyph',
                '<text font-family="Quicksand">中</text>',
                'the font for "quicksand" has no glyph for "中" (U+4E2D)',
            ],
        ];
        for (const [name, body, reason] of reported)
            it(name, () => {
                for (const optimize of [true, false])
                    expect(textWarnings(svg(body), { optimize, fonts: FONTS })).toEqual([
                        `<text> cannot be represented in a VectorDrawable (${reason}); skipped.`,
                    ]);
            });
    });

    describe('the same reason on several <text>s is reported once (T-144)', () => {
        const message = (reason: string): string =>
            `<text> cannot be represented in a VectorDrawable (${reason}); skipped.`;
        const MISSING = 'no font for font-family Inter in the fonts option';

        it('three <text>s in a font not given: one warning, in both modes', () => {
            const three = '<text y="10" font-family="Inter">a</text>'.repeat(3);
            for (const optimize of [true, false])
                expect(textWarnings(svg(`<g fill="red">${three}</g>`), { optimize, fonts: FONTS })).toEqual([
                    message(MISSING),
                ]);
        });

        it('different reasons stay separate warnings, each once', () => {
            const body =
                '<text y="10" font-family="Inter">a</text><text y="20" font-family="Quicksand">中</text>'.repeat(2);
            for (const optimize of [true, false])
                expect(textWarnings(svg(body), { optimize, fonts: FONTS })).toEqual([
                    message(MISSING),
                    message('the font for "quicksand" has no glyph for "中" (U+4E2D)'),
                ]);
        });

        it('each conversion reports it again', () => {
            const source = svg('<text font-family="Inter">a</text><text font-family="Inter">b</text>');
            for (let i = 0; i < 2; i++) expect(textWarnings(source)).toEqual([message(MISSING)]);
        });
    });

    describe('a font opentype.js cannot shape (T-131)', () => {
        afterEach(() => {
            vi.doUnmock('node:module');
            vi.resetModules();
        });

        /** convert on a fresh module graph whose opentype.js parses Quicksand, then throws on shaping. */
        async function convertWithUnshapable(): Promise<typeof convert> {
            vi.resetModules();
            vi.doMock('node:module', async (importOriginal) => {
                const real = await importOriginal<typeof import('node:module')>();
                return {
                    ...real,
                    createRequire: (url: string | URL) => (id: string) => {
                        const lib = real.createRequire(url)(id) as { parse: (b: Uint8Array) => object };
                        if (id !== 'opentype.js') return lib;
                        return {
                            parse: (bytes: Uint8Array) => {
                                const font = lib.parse(bytes);
                                const fail = (): never => {
                                    throw new Error(
                                        'substitutionType : 62 lookupType: 6 - substFormat: 2 is not yet supported',
                                    );
                                };
                                return Object.assign(Object.create(font) as object, {
                                    getAdvanceWidth: fail,
                                    getPath: fail,
                                });
                            },
                        };
                    },
                };
            });
            return (await import('../src/index.js')).convert;
        }

        const REASON =
            '<text> cannot be represented in a VectorDrawable (the font for "quicksand" cannot be shaped by opentype.js (substitutionType : 62 lookupType: 6 - substFormat: 2 is not yet supported)); skipped.';

        it('skips the text with unsupported-element and converts the rest, in both modes', async () => {
            const fresh = await convertWithUnshapable();
            for (const anchor of ['start', 'middle']) {
                const source = svg(
                    `<rect width="10" height="10" fill="red"/><text x="5" y="28" font-family="Quicksand" text-anchor="${anchor}">ab</text><text x="5" y="38" font-family="Quicksand">cd</text>`,
                );
                for (const optimize of [true, false]) {
                    const result = fresh(source, { fonts: FONTS, optimize });
                    // Two <text>s, one reason: reported once (T-144).
                    expect(result.warnings.map((w) => [w.code, w.message])).toEqual([['unsupported-element', REASON]]);
                    expect(result.xml.match(/<path\b/g)).toHaveLength(1);
                    expect(result.xml).toContain('android:fillColor="#FFFF0000"');
                }
            }
        });

        it('strict mode throws the ConversionError, not the opentype.js error', async () => {
            const fresh = await convertWithUnshapable();
            const { ConversionError } = await import('../src/index.js');
            const source = svg('<text x="5" y="28" font-family="Quicksand">ab</text>');
            for (const optimize of [true, false]) {
                let error: unknown;
                try {
                    fresh(source, { fonts: FONTS, optimize, strict: true });
                } catch (err) {
                    error = err;
                }
                expect(error).toBeInstanceOf(ConversionError);
                expect((error as Error).message).toContain('cannot be shaped by opentype.js');
            }
        });

        it('a real font hitting it (DejaVu Sans, when installed)', () => {
            const dejavu = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
            if (!existsSync(dejavu)) return;
            const source = svg('<rect width="10" height="10"/><text x="5" y="28" font-family="DejaVu Sans">ab</text>');
            for (const optimize of [true, false]) {
                const result = convert(source, { fonts: { 'DejaVu Sans': dejavu }, optimize });
                expect(result.warnings.map((w) => w.message)).toEqual([
                    expect.stringMatching(
                        /the font for "dejavu sans" cannot be shaped by opentype\.js \(.+\)\); skipped\.$/,
                    ),
                ]);
                expect(result.xml.match(/<path\b/g)).toHaveLength(1);
            }
        });
    });

    describe('the fonts option itself', () => {
        const TEXT = svg('<text x="5" y="28" font-family="Quicksand">Hi</text>');

        it('rejects an invalid value (TypeError)', () => {
            expect(() => convert(TEXT, { fonts: null as never })).toThrow(TypeError);
            expect(() => convert(TEXT, { fonts: { Quicksand: 42 as never } })).toThrow(
                'Invalid fonts["Quicksand"]: expected a font file path or a Uint8Array',
            );
        });

        it('fails on a font file it cannot read or parse', () => {
            expect(() => convert(TEXT, { fonts: { Quicksand: '/nonexistent/font.ttf' } })).toThrow(
                /^Cannot read the font file \/nonexistent\/font\.ttf: ENOENT/,
            );
            expect(() => convert(TEXT, { fonts: { Quicksand: new Uint8Array([1, 2, 3, 4]) } })).toThrow(
                /^Cannot parse the font the bytes given for "quicksand"/,
            );
        });

        it('is rejected by the browser builds, which carry no font code', () => {
            expect(() => browserTextLayout({})).toThrow(
                new TypeError(
                    'The fonts option (<text> as glyph outlines) is only available in the Node build of svg-vectordrawable.',
                ),
            );
        });
    });
});

describe('a <tspan> blend mode, attribute or style, gives the <text> rejection alone (T-161)', () => {
    const forms = [
        'mix-blend-mode="multiply"',
        'style="mix-blend-mode:multiply"',
        'style="fill:inherit; mix-blend-mode: Multiply"',
    ];
    const source = (form: string): string =>
        svg(`<text x="5" y="28" font-family="Quicksand">a<tspan ${form}>b</tspan> c</text>`);
    const REJECTED =
        '<text> cannot be represented in a VectorDrawable (<tspan> with its own mix-blend-mode is not supported); skipped.';

    it('the same rejection names the property in both forms and both modes; strict rejects', () => {
        for (const form of forms)
            for (const optimize of [true, false]) {
                expect(
                    textWarnings(source(form), { fonts: FONTS, optimize }),
                    `${form}, optimize: ${optimize}`,
                ).toEqual([REJECTED]);
                expect(() => convert(source(form), { fonts: FONTS, optimize, strict: true })).toThrow(ConversionError);
            }
    });

    // applyCssProperties does not report a blend on <text> content: the <tspan> rejection covers it.
    it('no other warning: the blend is not reported as ignored, the <text> being rejected', () => {
        for (const form of forms)
            for (const optimize of [true, false])
                expect(
                    convert(source(form), { fonts: FONTS, optimize }).warnings.map((w) => w.message),
                    `${form}, optimize: ${optimize}`,
                ).toEqual([REJECTED]);
    });
});

describe('<text> without the fonts option is reported once (T-159)', () => {
    const three = svg(
        '<text x="5" y="10">A</text><text x="5" y="20" fill="red">B</text>' +
            '<g><text x="5" y="30">C</text></g><rect width="10" height="10"/>',
    );

    for (const optimize of [true, false])
        it(`three <text> give one warning (optimize: ${optimize})`, () => {
            const { warnings, xml } = convert(three, { optimize });
            expect(warnings.filter((w) => w.node === 'text')).toEqual([
                { code: 'unsupported-element', message: UNCHANGED, node: 'text' },
            ]);
            expect(xml).toContain('<path'); // the <rect> is still drawn
        });

    it('the output is unchanged: same as a single <text>', () => {
        const one = svg('<text x="5" y="10">A</text><rect width="10" height="10"/>');
        for (const optimize of [true, false])
            expect(convert(three, { optimize }).xml).toBe(convert(one, { optimize }).xml);
    });

    it('strict still rejects', () => {
        for (const optimize of [true, false])
            expect(() => convert(three, { optimize, strict: true })).toThrow(ConversionError);
    });

    it('each conversion reports it again', () => {
        expect(textWarnings(three, {})).toEqual([UNCHANGED]);
        expect(textWarnings(three, {})).toEqual([UNCHANGED]);
    });
});
