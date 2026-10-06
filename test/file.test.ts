import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertDir, convertFile } from '../src/file.js';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#f00"/></svg>';
const DASHED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24" stroke="#000" stroke-dasharray="1em"/></svg>';

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
});
