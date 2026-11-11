import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batchOutputPath, convertDir, convertFile, findOutputCollisions, listSvgFiles } from '../src/file.js';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#f00"/></svg>';
const DASHED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24" stroke="#000" stroke-dasharray="1ex"/></svg>';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svgvd-file-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('convertFile', () => {
    it('defaults the output to the input path with a .xml extension', () => {
        const input = join(dir, 'icon.svg');
        writeFileSync(input, ICON);
        const result = convertFile(input);
        const written = readFileSync(join(dir, 'icon.xml'), 'utf8');
        expect(written).toBe(result.xml);
        expect(written).toContain('<vector');
    });

    it('writes to an explicit path and creates its parent directories', () => {
        const input = join(dir, 'icon.svg');
        writeFileSync(input, ICON);
        const target = join(dir, 'a', 'b', 'custom.xml');
        convertFile(input, target);
        expect(readFileSync(target, 'utf8')).toContain('<vector');
    });

    it('forwards options to convert', () => {
        const input = join(dir, 'dashed.svg');
        writeFileSync(input, DASHED);
        expect(() => convertFile(input, undefined, { strict: true })).toThrow();
        expect(existsSync(join(dir, 'dashed.xml'))).toBe(false);
    });
});

describe('convertDir', () => {
    it('converts only top-level .svg files and reports warnings per file', () => {
        const src = join(dir, 'src');
        mkdirSync(join(src, 'sub'), { recursive: true });
        writeFileSync(join(src, 'icon.svg'), ICON);
        writeFileSync(join(src, 'dashed.SVG'), DASHED);
        writeFileSync(join(src, 'readme.txt'), 'not an svg');
        writeFileSync(join(src, 'sub', 'nested.svg'), ICON);
        const out = join(dir, 'out', 'drawables');

        const results = convertDir(src, out);

        const byInput = Object.fromEntries(results.map((r) => [r.input, r]));
        expect(Object.keys(byInput).sort()).toEqual([join(src, 'dashed.SVG'), join(src, 'icon.svg')]);
        expect(byInput[join(src, 'icon.svg')]!.output).toBe(join(out, 'icon.xml'));
        expect(byInput[join(src, 'icon.svg')]!.warnings).toEqual([]);
        expect(byInput[join(src, 'dashed.SVG')]!.warnings.map((w) => w.code)).toContain('unsupported-stroke-dasharray');
        expect(existsSync(join(out, 'icon.xml'))).toBe(true);
        expect(existsSync(join(out, 'dashed.xml'))).toBe(true);
        expect(existsSync(join(out, 'nested.xml'))).toBe(false);
        expect(existsSync(join(out, 'readme.xml'))).toBe(false);
    });
});

describe('Android resource names', () => {
    it('convertFile renames the default output with androidNames', () => {
        const input = join(dir, 'Arrow-Left.svg');
        writeFileSync(input, ICON);
        convertFile(input, undefined, undefined, { androidNames: true });
        expect(existsSync(join(dir, 'arrow_left.xml'))).toBe(true);
    });

    it('convertFile keeps an explicit output path verbatim', () => {
        const input = join(dir, 'Arrow-Left.svg');
        writeFileSync(input, ICON);
        const target = join(dir, 'My-Icon.xml');
        convertFile(input, target, undefined, { androidNames: true });
        expect(existsSync(target)).toBe(true);
    });

    it('convertDir keeps the source names by default', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
        const out = join(dir, 'out');
        expect(convertDir(src, out).map((r) => r.output)).toEqual([join(out, 'Arrow-Left.xml')]);
    });

    it('convertDir writes valid resource names with androidNames', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
        writeFileSync(join(src, '24-hours.svg'), ICON);
        const out = join(dir, 'out');
        const results = convertDir(src, out, undefined, { androidNames: true });
        expect(results.map((r) => r.output).sort()).toEqual([
            join(out, 'arrow_left.xml'),
            join(out, 'ic_24_hours.xml'),
        ]);
        expect(existsSync(join(out, 'arrow_left.xml'))).toBe(true);
        expect(existsSync(join(out, 'ic_24_hours.xml'))).toBe(true);
    });

    it('convertDir fails before writing anything on a name collision', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
        writeFileSync(join(src, 'arrow_left.svg'), ICON);
        writeFileSync(join(src, 'other.svg'), ICON);
        const out = join(dir, 'out');
        expect(() => convertDir(src, out, undefined, { androidNames: true })).toThrow(
            /arrow_left.*Arrow-Left\.svg.*arrow_left\.svg/s,
        );
        expect(existsSync(out)).toBe(false);
    });

    it('convertDir fails before writing anything when two files get the same output, without androidNames', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'a.svg'), ICON);
        writeFileSync(join(src, 'a.SVG'), ICON);
        const out = join(dir, 'out');
        expect(() => convertDir(src, out)).toThrow(
            `Output collision (nothing written):\n  ${join(out, 'a.xml')}: ${join(src, 'a.SVG')}, ${join(src, 'a.svg')}`,
        );
        expect(existsSync(out)).toBe(false);
    });

    it('convertDir fails before writing anything when two outputs differ only by case', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'A.svg'), ICON);
        writeFileSync(join(src, 'a.svg'), ICON);
        const out = join(dir, 'out');
        expect(() => convertDir(src, out)).toThrow(
            `Output collision (nothing written):\n  ${join(out, 'A.xml')}, ${join(out, 'a.xml')}: ${join(src, 'A.svg')}, ${join(src, 'a.svg')}`,
        );
        expect(existsSync(out)).toBe(false);
    });
});

describe('listSvgFiles', () => {
    it('lists only the top level by default, sorted by name', () => {
        mkdirSync(join(dir, 'sub'));
        for (const name of ['b.svg', 'a.SVG', 'c.txt', join('sub', 'd.svg')]) writeFileSync(join(dir, name), ICON);
        mkdirSync(join(dir, 'folder.svg'));
        expect(listSvgFiles(dir)).toEqual([join(dir, 'a.SVG'), join(dir, 'b.svg')]);
    });

    it('walks subdirectories depth first with recursive, without following directory links', () => {
        mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
        for (const name of ['z.svg', join('sub', 'b.svg'), join('sub', 'deep', 'c.svg')])
            writeFileSync(join(dir, name), ICON);
        symlinkSync(dir, join(dir, 'sub', 'loop'), 'dir');
        expect(listSvgFiles(dir, true)).toEqual([
            join(dir, 'sub', 'b.svg'),
            join(dir, 'sub', 'deep', 'c.svg'),
            join(dir, 'z.svg'),
        ]);
    });
});

describe('batchOutputPath', () => {
    const root = join('icons');
    const input = join('icons', 'outline', 'Arrow-Left.svg');

    it('keeps the path relative to the input directory under the output directory', () => {
        expect(batchOutputPath(input, root, 'out')).toBe(join('out', 'outline', 'Arrow-Left.xml'));
        expect(batchOutputPath(join(root, 'a.svg'), root, 'out')).toBe(join('out', 'a.xml'));
    });

    it('is flat with androidNames', () => {
        expect(batchOutputPath(input, root, 'out', { androidNames: true })).toBe(join('out', 'arrow_left.xml'));
    });

    it('writes next to the input without an output directory', () => {
        expect(batchOutputPath(input, root)).toBe(join('icons', 'outline', 'Arrow-Left.xml'));
        expect(batchOutputPath(input, root, undefined, { androidNames: true })).toBe(
            join('icons', 'outline', 'arrow_left.xml'),
        );
    });
});

describe('findOutputCollisions', () => {
    const entries = [
        { input: 'a/x.svg', output: 'out/x.xml' },
        { input: 'b/x.svg', output: 'out/x.xml' },
        { input: 'c.svg', output: 'out/c.xml' },
    ];

    it('groups the inputs sharing an output path', () => {
        expect(findOutputCollisions(entries)).toEqual([{ name: 'out/x.xml', inputs: ['a/x.svg', 'b/x.svg'] }]);
    });

    it('is empty when every output is distinct', () => {
        expect(findOutputCollisions(entries.slice(1))).toEqual([]);
    });

    it('groups output paths differing only by case (one file on macOS and Windows)', () => {
        expect(
            findOutputCollisions([
                { input: 'aBc.svg', output: 'out/ABc.kt' },
                { input: 'abC.svg', output: 'out/AbC.kt' },
            ]),
        ).toEqual([{ name: 'out/ABc.kt, out/AbC.kt', inputs: ['aBc.svg', 'abC.svg'] }]);
    });
});
