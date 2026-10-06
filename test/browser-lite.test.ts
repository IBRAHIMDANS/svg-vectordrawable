import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { _collections, optimize as svgoOptimize } from 'svgo';
import { convert as convertMain } from '../src/browser.js';
import { optimize as liteOptimize, parseXml, _collections as liteCollections } from '../src/svgo-lite.js';

type LiteModule = typeof import('../src/browser-lite.js');

const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixtures = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => [f, readFileSync(join(FIXTURES, f), 'utf8')] as const);

/** svgo's own AST for `svg` (parse only, no plugin), the reference for the lite parser. */
function svgoAst(svg: string): unknown {
    let root: unknown;
    svgoOptimize(svg, {
        plugins: [
            {
                name: 'capture',
                fn: (r) => {
                    root = r;
                    return {};
                },
            },
        ],
    });
    return root;
}

// Load the lite entry exactly as the browser-lite bundle sees it: `svgo` replaced by svgo-lite
// (the tsup alias), in a fresh module graph so the main entry above keeps the real svgo.
let lite: LiteModule;
beforeAll(async () => {
    vi.resetModules();
    vi.doMock('svgo', () => import('../src/svgo-lite.js'));
    lite = await import('../src/browser-lite.js');
    vi.doUnmock('svgo');
});

describe('browser-lite entry', () => {
    it.each(fixtures)('%s converts byte-identically to the main entry with optimize:false', (_name, svg) => {
        const expected = convertMain(svg, { optimize: false });
        const actual = lite.convert(svg);
        expect(actual.xml).toBe(expected.xml);
        expect(actual.warnings).toEqual(expected.warnings);
    });

    it('passes the other options through', () => {
        const svg = readFileSync(join(FIXTURES, 'linear-gradient.svg'), 'utf8');
        const options = { floatPrecision: 1, indent: 2, xmlTag: true } as const;
        expect(lite.convert(svg, options).xml).toBe(convertMain(svg, { ...options, optimize: false }).xml);
    });

    it('rejects optimize:true with an explicit TypeError', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
        // @ts-expect-error optimize is typed `false` in the lite build
        expect(() => lite.convert(svg, { optimize: true })).toThrow(TypeError);
        // @ts-expect-error same
        expect(() => lite.convert(svg, { optimize: true })).toThrow(/browser-lite/);
    });

    it('resolves CSS named colors', () => {
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
            '<path d="M0 0h5v5z" fill="rebeccapurple"/><path d="M5 5h5v5z" fill="Red" stroke="navy"/></svg>';
        const out = lite.convert(svg).xml;
        expect(out).toBe(convertMain(svg, { optimize: false }).xml);
        expect(out).toMatch(/fillColor="#(FF)?663399"/i);
        expect(out).toMatch(/strokeColor="#(FF)?000080"/i);
    });

    it('exposes the same runtime API as the browser entry', async () => {
        const main = await import('../src/browser.js');
        expect(Object.keys(lite).sort()).toEqual(Object.keys(main).sort());
        expect(lite.WARNING_CODES).toEqual(main.WARNING_CODES);
    });

    it('fails loud on malformed XML', () => {
        for (const svg of [
            '<svg><g></svg>',
            '<svg><path d=M0/></svg>',
            '<svg><path fill/></svg>',
            '<svg><path xlink:href="#a"/></svg>',
            '<svg',
            '<svg>&constructor;</svg>',
            // Accepted by svgo (HTML entity) but not by svgo-lite: proves the lite parser is in use.
            '<svg>&nbsp;</svg>',
        ])
            expect(() => lite.convert(svg), svg).toThrow(/Invalid SVG/);
    });
});

describe('svgo-lite parser', () => {
    const EDGE_CASES = [
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Generator: x -->\n<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n  <!ENTITY ns_svg "http://www.w3.org/2000/svg">\n  <!ENTITY c \'#f00\'>\n]>\n<svg xmlns="&ns_svg;"><path fill="&c;" d="M0 0"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[ .a { fill: red } ]]></style><path class="a" d="M0 0"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><text x="1">  a &amp; b <tspan> c </tspan>\n</text><title> t </title><desc>  d  </desc></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#p" x = \'1\' /></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0&#x20;0&#10;L1 1" fill="#000" fill="#fff" data-x="&lt;&gt;&quot;&apos;&#65;&#x1F600;"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"\n\tviewBox="0 0 24 24"\n><g  >a<!--x-->b</g ></svg>',
    ];

    it.each([...fixtures.map(([, svg]) => svg), ...EDGE_CASES])('matches svgo AST #%#', (svg) => {
        expect(parseXml(svg)).toEqual(svgoAst(svg));
    });

    it('ships the same named-color table as svgo', () => {
        expect(liteCollections.colorsNames).toEqual(
            (_collections as unknown as { colorsNames: Record<string, string> }).colorsNames,
        );
        expect([...liteCollections.textElems]).toEqual([
            ...(_collections as unknown as { textElems: Set<string> }).textElems,
        ]);
    });

    it('rejects builtin svgo plugins (no normalization in the lite build)', () => {
        const svg = '<svg/>';
        expect(() => liteOptimize(svg, { plugins: ['preset-default'] })).toThrow(/preset-default.*browser-lite/);
        expect(() => liteOptimize(svg, { plugins: [{ name: 'convertColors' }] })).toThrow(/convertColors/);
    });
});
