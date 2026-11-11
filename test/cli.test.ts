import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#f00"/></svg>';
const DASHED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24" stroke="#000" stroke-dasharray="1ex"/></svg>';

interface CliResult {
    status: number;
    stdout: string;
    stderr: string;
}

// Runs the CLI in-process with captured output (tsx is not a local dependency, so no spawn).
function svgvd(...args: string[]): CliResult {
    let stdout = '';
    let stderr = '';
    const status = run(args, {
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
    });
    return { status, stdout, stderr };
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svgvd-cli-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('svgvd CLI', () => {
    it('writes <name>.xml next to a single input file', () => {
        const input = join(dir, 'icon.svg');
        writeFileSync(input, ICON);
        const res = svgvd(input);
        expect(res.status).toBe(0);
        expect(readFileSync(join(dir, 'icon.xml'), 'utf8')).toContain('<vector');
        expect(res.stderr).toContain('✓');
    });

    it('writes to an explicit -o file.xml, creating missing parent directories', () => {
        const input = join(dir, 'icon.svg');
        writeFileSync(input, ICON);
        const target = join(dir, 'nested', 'deep', 'out.xml');
        const res = svgvd(input, '-o', target);
        expect(res.status).toBe(0);
        expect(readFileSync(target, 'utf8')).toContain('<vector');
    });

    it('converts a directory into a non-existent output directory', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'a.svg'), ICON);
        writeFileSync(join(src, 'b.svg'), ICON);
        const out = join(dir, 'out');
        const res = svgvd(src, '-o', out);
        expect(res.stderr).not.toContain('ENOENT');
        expect(res.status).toBe(0);
        expect(existsSync(join(out, 'a.xml'))).toBe(true);
        expect(existsSync(join(out, 'b.xml'))).toBe(true);
    });

    it('prints to stdout with --stdout and writes no file', () => {
        const input = join(dir, 'icon.svg');
        writeFileSync(input, ICON);
        const res = svgvd(input, '--stdout');
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('<vector');
        expect(existsSync(join(dir, 'icon.xml'))).toBe(false);
    });

    it('converts an inline string with -s', () => {
        const res = svgvd('-s', ICON);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('<vector');
        expect(res.stdout).toContain('android:fillColor="#FFFF0000"');
    });

    it('writes an inline string to -o file.xml, creating missing parent directories', () => {
        const target = join(dir, 'nested', 'inline.xml');
        const res = svgvd('-s', ICON, '-o', target);
        expect(res.status).toBe(0);
        expect(res.stdout).toBe('');
        expect(readFileSync(target, 'utf8')).toContain('<vector');
    });

    it('exits 1 and prints the help on stderr without input', () => {
        const res = svgvd();
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('Usage:');
    });

    it('fails with exit code 1 under --strict on an unsupported construct', () => {
        const input = join(dir, 'dashed.svg');
        writeFileSync(input, DASHED);
        const res = svgvd(input, '--strict');
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('✗');
        expect(existsSync(join(dir, 'dashed.xml'))).toBe(false);
    });

    it('downgrades a rule to a warning with --rule under --strict', () => {
        const input = join(dir, 'dashed.svg');
        writeFileSync(input, DASHED);
        const res = svgvd(input, '--strict', '--rule', 'unsupported-stroke-dasharray=warn');
        expect(res.status).toBe(0);
        expect(res.stderr).toContain('[unsupported-stroke-dasharray]');
        expect(existsSync(join(dir, 'dashed.xml'))).toBe(true);
    });

    it('rejects an invalid --rule and lists the known codes', () => {
        const res = svgvd('-s', ICON, '--rule', 'foo=bar');
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('Invalid --rule');
        expect(res.stderr).toContain('unsupported-stroke-dasharray');
    });

    it('rejects an unknown option', () => {
        const res = svgvd('--nope');
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('Unknown option: --nope');
    });

    it('keeps the source name without --android-names', () => {
        const input = join(dir, 'Arrow-Left.svg');
        writeFileSync(input, ICON);
        expect(svgvd(input).status).toBe(0);
        expect(existsSync(join(dir, 'Arrow-Left.xml'))).toBe(true);
    });

    it('writes a valid resource name next to a single input with --android-names', () => {
        const input = join(dir, 'Arrow-Left.svg');
        writeFileSync(input, ICON);
        const res = svgvd(input, '--android-names');
        expect(res.status).toBe(0);
        expect(existsSync(join(dir, 'arrow_left.xml'))).toBe(true);
        expect(existsSync(join(dir, 'Arrow-Left.xml'))).toBe(false);
    });

    it('uses an explicit -o file.xml verbatim with --android-names', () => {
        const input = join(dir, 'Arrow-Left.svg');
        writeFileSync(input, ICON);
        const target = join(dir, 'My-Icon.xml');
        const res = svgvd(input, '--android-names', '-o', target);
        expect(res.status).toBe(0);
        expect(existsSync(target)).toBe(true);
    });

    it('renames batch outputs with --android-names', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
        writeFileSync(join(src, 'new.svg'), ICON);
        const out = join(dir, 'out');
        const res = svgvd(src, '-o', out, '--android-names');
        expect(res.status).toBe(0);
        expect(existsSync(join(out, 'arrow_left.xml'))).toBe(true);
        expect(existsSync(join(out, 'new_.xml'))).toBe(true);
    });

    it('fails before writing anything on a resource name collision', () => {
        const src = join(dir, 'src');
        mkdirSync(src);
        writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
        writeFileSync(join(src, 'arrow_left.svg'), ICON);
        writeFileSync(join(src, 'other.svg'), ICON);
        const out = join(dir, 'out');
        const res = svgvd(src, '-o', out, '--android-names');
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('arrow_left');
        expect(res.stderr).toContain(join(src, 'Arrow-Left.svg'));
        expect(res.stderr).toContain(join(src, 'arrow_left.svg'));
        expect(existsSync(out)).toBe(false);
    });

    it('documents --android-names in the help', () => {
        expect(svgvd('--help').stdout).toContain('--android-names');
    });

    it('prints the help with --help', () => {
        const res = svgvd('--help');
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Usage:');
    });

    describe('invalid invocations fail with a message, not a stack trace', () => {
        it.each(['abc', '-1', '1.5', ''])('rejects --precision %j', (value) => {
            const res = svgvd('-s', ICON, '-p', value);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('Invalid --precision');
            expect(res.stdout).toBe('');
        });

        it.each(['-p', '-s', '-o', '--tint', '--rule', '--min-sdk'])('rejects %s without a value', (flag) => {
            const res = svgvd(flag);
            expect(res.status).toBe(1);
            expect(res.stderr).toBe(`Missing value for ${flag}\n`);
        });

        it('reports a missing input file and still converts the others', () => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            const res = svgvd(join(dir, 'nope.svg'), input);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain(`✗ ${join(dir, 'nope.svg')}: no such file or directory`);
            expect(existsSync(join(dir, 'icon.xml'))).toBe(true);
        });

        it('reports a rejected inline SVG (--strict)', () => {
            const res = svgvd('--strict', '-s', DASHED);
            expect(res.status).toBe(1);
            expect(res.stderr).toMatch(/^✗ \[unsupported-stroke-dasharray\]/);
            expect(res.stdout).toBe('');
        });

        it('reports an invalid inline SVG', () => {
            const res = svgvd('-s', 'not svg');
            expect(res.status).toBe(1);
            expect(res.stderr).toMatch(/^✗ Invalid SVG/);
        });

        it('rejects "-" (stdin is not read)', () => {
            const res = svgvd('-');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('stdin is not supported');
        });
    });

    describe('--strict=lossy and --min-sdk', () => {
        // Group opacity over overlapping children: an approximation, not a loss.
        const APPROX =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g opacity="0.5">' +
            '<rect width="12" height="12"/><rect x="6" y="6" width="12" height="12"/></g></svg>';
        const EVEN_ODD =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
            '<path d="M0 0h24v24H0zM6 6h12v12H6z" fill-rule="evenodd"/></svg>';

        it('fails on a lossy construct with --strict=lossy', () => {
            const input = join(dir, 'dashed.svg');
            writeFileSync(input, DASHED);
            const res = svgvd(input, '--strict=lossy');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('[unsupported-stroke-dasharray]');
            expect(existsSync(join(dir, 'dashed.xml'))).toBe(false);
        });

        it('keeps approximations as warnings with --strict=lossy, but fails with --strict', () => {
            const input = join(dir, 'approx.svg');
            writeFileSync(input, APPROX);
            const lossy = svgvd(input, '--strict=lossy');
            expect(lossy.status).toBe(0);
            expect(lossy.stderr).toContain('[opacity-approximated]');
            expect(existsSync(join(dir, 'approx.xml'))).toBe(true);
            expect(svgvd(input, '--strict', '-o', join(dir, 'other.xml')).status).toBe(1);
        });

        it('rejects an unknown --strict preset', () => {
            const res = svgvd('-s', ICON, '--strict=approximation');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('Unknown option: --strict=approximation');
        });

        it('warns with --min-sdk when the output needs a higher API level', () => {
            const res = svgvd('-s', EVEN_ODD, '--min-sdk', '21');
            expect(res.status).toBe(0);
            expect(res.stderr).toContain('[min-sdk-exceeded]');
            expect(res.stderr).toContain('android:fillType');
            expect(svgvd('-s', EVEN_ODD, '--min-sdk', '24').stderr).toBe('');
        });

        it('fails with --min-sdk and --rule min-sdk-exceeded=error', () => {
            const input = join(dir, 'evenodd.svg');
            writeFileSync(input, EVEN_ODD);
            const res = svgvd(input, '--min-sdk', '21', '--rule', 'min-sdk-exceeded=error');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('✗');
        });

        it('rejects an invalid --min-sdk', () => {
            for (const value of ['abc', '0', '21.5', '-1']) {
                const res = svgvd('-s', ICON, '--min-sdk', value);
                expect(res.status).toBe(1);
                expect(res.stderr).toContain('Invalid --min-sdk');
            }
            expect(svgvd('-s', ICON, '--min-sdk').status).toBe(1);
        });

        it('documents --strict=lossy and --min-sdk in the help', () => {
            const help = svgvd('--help').stdout;
            expect(help).toContain('--strict=lossy');
            expect(help).toContain('--min-sdk <n>');
        });
    });

    describe('--auto-mirrored, --width and --height', () => {
        it('adds android:autoMirrored with --auto-mirrored', () => {
            expect(svgvd('-s', ICON, '--auto-mirrored').stdout).toContain('android:autoMirrored="true"');
            expect(svgvd('-s', ICON).stdout).not.toContain('autoMirrored');
        });

        it('overrides the size in dp, keeping the viewport and the aspect ratio', () => {
            const both = svgvd('-s', ICON, '--width', '48', '--height', '32.5').stdout;
            expect(both).toContain('android:width="48dp"');
            expect(both).toContain('android:height="32.5dp"');
            expect(both).toContain('android:viewportWidth="24"');
            const one = svgvd('-s', ICON, '--height', '.5').stdout;
            expect(one).toContain('android:width="0.5dp"');
            expect(one).toContain('android:height="0.5dp"');
        });

        it.each(['--width', '--height'])('rejects an invalid %s', (flag) => {
            for (const value of ['abc', '0', '-1', '0.0', '1e2', '48dp', '']) {
                const res = svgvd('-s', ICON, flag, value);
                expect(res.status).toBe(1);
                expect(res.stderr).toContain(`Invalid ${flag}`);
            }
            expect(svgvd('-s', ICON, flag).status).toBe(1);
        });

        it('emits a --current-color reference and --color-map references (repeatable)', () => {
            const icon =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h9v9z" fill="#1A73E8"/>' +
                '<path d="M9 9h9v9z" fill="red"/><path d="M0 9h9v9z" fill="none" stroke="currentColor"/></svg>';
            const res = svgvd(
                '-s',
                icon,
                '--current-color',
                '?attr/colorOnSurface',
                '--color-map',
                '#1a73e8=@color/brand',
                '--color-map',
                ' #f00 =?android:attr/colorAccent',
            );
            expect(res.status).toBe(0);
            expect(res.stdout).toContain('android:fillColor="@color/brand"');
            expect(res.stdout).toContain('android:fillColor="?android:attr/colorAccent"');
            expect(res.stdout).toContain('android:strokeColor="?attr/colorOnSurface"');
        });

        it.each([
            [['--color-map', '#f00'], 'Invalid --color-map'],
            [['--color-map', '=@color/brand'], 'Invalid --color-map'],
            [['--color-map', '#f00=@color/'], 'Invalid colorMap value'],
            [['--color-map', 'wat=@color/brand'], 'Invalid colorMap key'],
            [['--current-color', '?colorPrimary'], 'malformed reference'],
            [['--current-color', 'wat'], 'Invalid currentColor'],
        ])('rejects %j before converting anything', (flags, message) => {
            const src = join(dir, 'src');
            mkdirSync(src);
            writeFileSync(join(src, 'a.svg'), ICON);
            writeFileSync(join(src, 'b.svg'), ICON);
            const res = svgvd(src, ...flags);
            expect(res.status).toBe(1);
            expect(res.stderr.split(message)).toHaveLength(2); // reported once, not per file
            expect(existsSync(join(src, 'a.xml'))).toBe(false);
        });

        it('documents the options in the help', () => {
            const help = svgvd('--help').stdout;
            expect(help).toContain('--current-color');
            expect(help).toContain('--color-map');
            expect(help).toContain('--auto-mirrored');
            expect(help).toContain('--width <dp>');
            expect(help).toContain('--height <dp>');
        });
    });
});
