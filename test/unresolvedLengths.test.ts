import { describe, it, expect } from 'vitest';
import { convert } from '../src/index.js';

/** The `unsupported-attribute` messages of a conversion. */
const unresolved = (body: string, optimize: boolean, viewBox = '0 0 100 100'): string[] =>
    convert(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`, { optimize })
        .warnings.filter((w) => w.code === 'unsupported-attribute')
        .map((w) => w.message);

describe.each([false, true])('unresolved lengths are reported (optimize: %s)', (optimize) => {
    it('stroke-width', () => {
        const messages = unresolved('<path d="M0 0H10" stroke="#000" stroke-width="1ex"/>', optimize);
        expect(messages).toEqual([expect.stringContaining('stroke-width="1ex" on <path>')]);
    });

    it('stroke-width inherited by several paths, once', () => {
        const messages = unresolved(
            '<g stroke="#000" stroke-width="1ex"><path d="M0 0H10"/><path d="M0 5H10"/></g>',
            optimize,
        );
        expect(messages).toHaveLength(1);
    });

    it('a shape coordinate', () => {
        const messages = unresolved('<circle cx="1ex" cy="50" r="10"/>', optimize);
        expect(messages).toEqual([expect.stringContaining('cx="1ex" on <circle>')]);
    });

    it('a shape size, instead of a bare empty-path', () => {
        const { warnings } = convert(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="1ex" height="10"/></svg>',
            { optimize },
        );
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute', 'empty-path']);
        expect(warnings[0]!.message).toContain('width="1ex" on <rect>');
    });

    it('rx / ry (auto per SVG 2, still reported), but not the keyword auto', () => {
        expect(unresolved('<rect width="10" height="10" rx="1ex"/>', optimize)).toEqual([
            expect.stringContaining('rx="1ex" on <rect>'),
        ]);
        expect(unresolved('<ellipse rx="10" ry="1ex"/>', optimize)).toEqual([
            expect.stringContaining('ry="1ex" on <ellipse>'),
        ]);
        expect(unresolved('<rect width="10" height="10" rx="auto" ry="2"/>', optimize)).toEqual([]);
    });

    it('a nested <svg> size', () => {
        const messages = unresolved('<svg width="1ex" height="50"><rect width="10" height="10"/></svg>', optimize);
        expect(messages).toEqual([expect.stringContaining('width="1ex" on <svg>')]);
    });

    it('a gradient coordinate, once per gradient', () => {
        const messages = unresolved(
            '<linearGradient id="g" x2="1ex"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>' +
                '<rect width="10" height="10" fill="url(#g)"/><rect y="20" width="10" height="10" fill="url(#g)"/>',
            optimize,
        );
        expect(messages).toEqual([expect.stringContaining('x2="1ex"')]);
    });

    it('a <use> size of a <symbol>', () => {
        const messages = unresolved(
            '<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol><use href="#s" width="1ex" height="10"/>',
            optimize,
        );
        expect(messages).toEqual([expect.stringContaining('<symbol> viewport size')]);
    });

    it('a shape instanced twice by <use>, once', () => {
        const messages = unresolved(
            '<defs><circle id="c" cx="1ex" cy="5" r="5"/></defs><use href="#c"/><use href="#c" y="20"/>',
            optimize,
        );
        expect(messages).toHaveLength(1);
    });

    it('a CSS geometry declaration, with the attribute applied instead', () => {
        expect(unresolved('<rect width="10" height="10" rx="2" style="rx:1ex"/>', optimize)).toEqual([
            expect.stringContaining(
                'rx="1ex" on <rect> is not a length the converter can resolve (ex, ch, calc()…); 2 is used.',
            ),
        ]);
        expect(unresolved('<rect width="10" height="10" style="width:calc(1px + 2px)"/>', optimize)).toEqual([
            expect.stringContaining('width="calc(1px + 2px)" on <rect>'),
        ]);
        expect(unresolved('<circle cx="5" cy="5" style="r:var(--r)"/>', optimize)).toEqual([
            expect.stringContaining('r="var(--r)" on <circle>'),
        ]);
    });

    it('a CSS declaration and its unresolved attribute, once', () => {
        expect(unresolved('<rect width="10" height="10" rx="1ch" style="rx:1ex"/>', optimize)).toEqual([
            expect.stringContaining('rx="1ex" on <rect>'),
        ]);
    });

    it('a CSS declaration overridden by a later valid one, not reported', () => {
        expect(unresolved('<rect width="10" height="10" style="rx:1ex;rx:2"/>', optimize)).toEqual([]);
    });

    it('invalid CSS that browsers drop too, not reported', () => {
        const body =
            '<rect width="10" height="10" rx="2" style="rx:foo;ry:1foo"/>' +
            '<rect width="10" height="10" style="width:-1ex"/><circle r="5" style="cx:1ex 2ex"/>';
        expect(unresolved(body, optimize)).toEqual([]);
    });

    it('a CSS declaration does not change the output', () => {
        const svg = (style: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="10" height="10" rx="2"${style}/></svg>`;
        expect(convert(svg(' style="rx:1ex"'), { optimize }).xml).toBe(convert(svg(''), { optimize }).xml);
    });

    it('nothing for absent, empty, auto or resolved lengths', () => {
        const body =
            '<rect x="10%" y="1em" width="2in" height="5mm" rx="auto" stroke="#000" stroke-width="2px"/>' +
            '<circle cx="50" cy="50" r="10%"/><ellipse cx="5" cy="5" rx="auto" ry="3"/>' +
            '<svg x="5" width="50%" height="1rem"><path d="M0 0H1"/></svg>' +
            '<ellipse cx="5" cy="5" rx="3" ry=""/><path d="M0 0H1" stroke="#000" stroke-width=""/>';
        expect(unresolved(body, optimize)).toEqual([]);
    });
});
