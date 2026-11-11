import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';

const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
const names = (xml: string): string[] => [...xml.matchAll(/android:name="([^"]*)"/g)].map((m) => m[1]!);
const ids = { preserveIds: true };

describe.each([true, false])('preserveIds (optimize: %s)', (optimize) => {
    const opts = { ...ids, optimize };

    it('names paths, shapes and groups after their id', () => {
        const { xml } = convert(
            svg('<g id="body"><path id="wing" d="M0 0h10v10z"/><rect id="tail" x="12" width="5" height="5"/></g>'),
            opts,
        );
        expect(xml).toContain(
            '    <group\n        android:name="body">\n        <path\n            android:name="wing"',
        );
        expect(names(xml)).toEqual(['body', 'wing', 'tail']);
    });

    it('keeps a named group with a transform as one <group>, name first', () => {
        const { xml } = convert(svg('<g id="spin" transform="rotate(90)"><path d="M0 0h4v4z"/></g>'), opts);
        expect(xml).toContain('<group\n        android:name="spin"\n        android:rotation="90">');
    });

    it('keeps a named group whose skew is baked into its content, with its clip', () => {
        const { xml, warnings } = convert(
            svg(
                '<clipPath id="cp"><rect width="5" height="5"/></clipPath>' +
                    '<g id="lean" transform="skewX(20)" clip-path="url(#cp)"><path id="p" d="M0 0h10v10z"/></g>',
            ),
            opts,
        );
        expect(warnings.map((w) => w.code)).toEqual([]);
        expect(xml).toMatch(
            /<group\n {8}android:name="lean">\n {8}<clip-path android:pathData="[^"]+" \/>\n {8}<path\n {12}android:name="p"/,
        );
    });

    it('emits nothing by default', () => {
        const source = svg('<g id="body"><path id="wing" d="M0 0h10v10z"/></g>');
        expect(convert(source, { optimize }).xml).not.toContain('android:name');
        expect(convert(source, { optimize, preserveIds: false }).xml).toBe(convert(source, { optimize }).xml);
    });

    it('escapes what XML needs in a name', () => {
        const { xml } = convert(svg('<path id="a&amp;b&quot;&lt;c&gt;\'" d="M0 0h4v4z"/>'), opts);
        expect(xml).toContain(`android:name="a&amp;b&quot;&lt;c&gt;'"`);
    });

    it('names only the first instance of a <use>, and nothing twice', () => {
        const { xml } = convert(
            svg(
                '<defs><g id="dot"><circle id="c" cx="2" cy="2" r="2"/></g></defs>' +
                    '<use href="#dot"/><use href="#dot" x="5"/><use href="#dot" x="10"/>',
            ),
            opts,
        );
        expect(names(xml)).toEqual(['dot', 'c']);
        expect(xml.match(/<path/g)).toHaveLength(3);
    });

    it('keeps every name unique on a fixture (use-ref.svg)', () => {
        const source = readFileSync(join(__dirname, 'fixtures', 'use-ref.svg'), 'utf8');
        const all = names(convert(source, opts).xml);
        expect(new Set(all).size).toBe(all.length);
    });

    it('never emits the ids the converter generates', () => {
        const { xml } = convert(
            svg(
                '<svg id="inner" x="1" y="1" width="10" height="10" viewBox="0 0 5 5"><path d="M0 0h9v9z"/></svg>' +
                    '<symbol id="sym" viewBox="0 0 2 2"><path d="M0 0h3v3z"/></symbol><use href="#sym" width="4" height="4"/>' +
                    '<mask id="m"><rect width="3" height="3" fill="#fff"/></mask><path id="masked" mask="url(#m)" d="M0 0h8v8z"/>',
            ),
            opts,
        );
        expect(names(xml)).toEqual(['inner', 'sym', 'masked']);
    });

    it('gives a duplicated id to the first element that draws something', () => {
        const { xml } = convert(svg('<g id="x"/><path id="x" d="M0 0h4v4z"/><path id="x" d="M5 5h4v4z"/>'), opts);
        expect(names(xml)).toEqual(['x']);
        expect(xml).toContain('<path\n        android:name="x"\n        android:pathData="M0 0h4v4z"');
    });
});

describe('preserveIds with the default svgo config', () => {
    it('neither merges named paths nor collapses named groups', () => {
        const { xml } = convert(
            svg('<g id="g"><path id="a" d="M0 0h4v4z"/></g><path id="b" d="M5 0h4v4z"/><path id="c" d="M10 0h4v4z"/>'),
            ids,
        );
        expect(names(xml)).toEqual(['g', 'a', 'b', 'c']);
    });

    it('does not minify a referenced id', () => {
        const { xml } = convert(svg('<path id="leaf" d="M0 0h4v4z"/><use href="#leaf" x="5"/>'), ids);
        expect(names(xml)).toEqual(['leaf']);
    });

    it('keeps the id of an element styled by an #id rule', () => {
        const { xml } = convert(svg('<style>#wing{fill:red}</style><path id="wing" d="M0 0h4v4z"/>'), ids);
        expect(names(xml)).toEqual(['wing']);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).not.toContain('data-svgvd');
    });

    it('keeps the transform of a named group on the group', () => {
        const { xml } = convert(svg('<g id="arm" transform="translate(2 3)"><path d="M0 0h4v4z"/></g>'), ids);
        expect(xml).toContain('android:name="arm"\n        android:translateX="2"\n        android:translateY="3">');
    });

    it('keeps the angle of a group skew it no longer pushes down (no skewX(27) for 26.565)', () => {
        const source = readFileSync(join(__dirname, 'fixtures', 'skew-group.svg'), 'utf8');
        expect(convert(source, ids).xml).toContain('android:pathData="M0 0L5 10L15 10Z"');
    });
});
