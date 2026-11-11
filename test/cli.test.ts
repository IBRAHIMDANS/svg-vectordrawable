import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type CliIo, type ReportEntry } from '../src/cli.js';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#f00"/></svg>';
const BLUR =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><circle cx="12" cy="12" r="8" fill="#1A73E8" filter="url(#f)"/></svg>';
const DENSITY_DIRS = ['drawable-hdpi', 'drawable-mdpi', 'drawable-xhdpi', 'drawable-xxhdpi', 'drawable-xxxhdpi'];
const DASHED =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24" stroke="#000" stroke-dasharray="1ex"/></svg>';

interface CliResult {
    status: number;
    stdout: string;
    stderr: string;
}

// Runs the CLI in-process with captured output (tsx is not a local dependency, so no spawn).
function runWith(stdin: CliIo['stdin'], args: string[]): CliResult {
    let stdout = '';
    let stderr = '';
    const status = run(args, {
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
        stdin,
    });
    return { status, stdout, stderr };
}

/** Without stdin, as when none can be read. */
function svgvd(...args: string[]): CliResult {
    return runWith(undefined, args);
}

/** With `text` piped on stdin (`isTTY` false), or typed in a terminal. */
function svgvdStdin(text: string, args: string[], isTTY = false): CliResult & { reads: number } {
    let reads = 0;
    const res = runWith(
        {
            read: () => {
                reads++;
                return text;
            },
            isTTY,
        },
        args,
    );
    return { ...res, reads };
}

function parseReport(stdout: string): ReportEntry[] {
    return JSON.parse(stdout) as ReportEntry[];
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

        it('rejects "-" when no stdin can be read', () => {
            const res = svgvd('-');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('stdin is not available');
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

    describe('stdin', () => {
        it('converts "-" to stdout', () => {
            const res = svgvdStdin(ICON, ['-']);
            expect(res.status).toBe(0);
            expect(res.stdout).toContain('android:fillColor="#FFFF0000"');
            expect(res.stderr).toBe('');
        });

        it('reads "-" even from a terminal', () => {
            const res = svgvdStdin(ICON, ['-'], true);
            expect(res.status).toBe(0);
            expect(res.stdout).toContain('<vector');
        });

        it('reads a pipe without input argument', () => {
            const res = svgvdStdin(ICON, ['--tint', '#FFFFFFFF']);
            expect(res.status).toBe(0);
            expect(res.stdout).toContain('android:tint="#FFFFFFFF"');
        });

        it('does not read a terminal without input argument, and prints the help', () => {
            const res = svgvdStdin(ICON, [], true);
            expect(res.status).toBe(1);
            expect(res.reads).toBe(0);
            expect(res.stderr).toContain('Usage:');
        });

        it('prints the help when nothing is piped', () => {
            const res = svgvdStdin('  \n', []);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('Usage:');
        });

        it('writes to -o file.xml, creating missing parent directories', () => {
            const target = join(dir, 'nested', 'stdin.xml');
            const res = svgvdStdin(ICON, ['-', '-o', target]);
            expect(res.status).toBe(0);
            expect(res.stdout).toBe('');
            expect(readFileSync(target, 'utf8')).toContain('<vector');
        });

        it('reports warnings and errors on one line, without the file name', () => {
            const warn = svgvdStdin(DASHED, ['-']);
            expect(warn.status).toBe(0);
            expect(warn.stderr).toMatch(/^ {2}⚠ \[unsupported-stroke-dasharray\] [^\n]*\n$/);
            const strict = svgvdStdin(DASHED, ['-', '--strict']);
            expect(strict.status).toBe(1);
            expect(strict.stderr).toMatch(/^✗ \[unsupported-stroke-dasharray\] [^\n]*\n$/);
            expect(strict.stdout).toBe('');
            const invalid = svgvdStdin('not svg', ['-']);
            expect(invalid.status).toBe(1);
            expect(invalid.stderr).toMatch(/^✗ Invalid SVG[^\n]*\n$/);
        });

        it('reports a stdin read error on one line', () => {
            const res = runWith(
                {
                    read: () => {
                        throw new Error('EAGAIN: resource temporarily unavailable, read');
                    },
                    isTTY: false,
                },
                ['-'],
            );
            expect(res.status).toBe(1);
            expect(res.stderr).toBe('✗ EAGAIN: resource temporarily unavailable, read\n');
        });

        it('rejects "-" with other inputs', () => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            const res = svgvdStdin(ICON, ['-', input]);
            expect(res.status).toBe(1);
            expect(res.reads).toBe(0);
            expect(res.stderr).toBe('- (stdin) cannot be combined with other inputs\n');
            expect(existsSync(join(dir, 'icon.xml'))).toBe(false);
        });

        it('ignores a piped stdin when inputs are given', () => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            const res = svgvdStdin(DASHED, [input]);
            expect(res.status).toBe(0);
            expect(res.reads).toBe(0);
            expect(existsSync(join(dir, 'icon.xml'))).toBe(true);
        });
    });

    describe('--recursive', () => {
        /** src/{a.svg, sub/b.svg, sub/deep/c.SVG, sub/notes.txt} */
        function tree(): string {
            const src = join(dir, 'src');
            mkdirSync(join(src, 'sub', 'deep'), { recursive: true });
            writeFileSync(join(src, 'a.svg'), ICON);
            writeFileSync(join(src, 'sub', 'b.svg'), ICON);
            writeFileSync(join(src, 'sub', 'deep', 'c.SVG'), ICON);
            writeFileSync(join(src, 'sub', 'notes.txt'), 'not an svg');
            return src;
        }

        it('converts subdirectories only with --recursive', () => {
            const src = tree();
            const out = join(dir, 'out');
            expect(svgvd(src, '-o', out).status).toBe(0);
            expect(existsSync(join(out, 'a.xml'))).toBe(true);
            expect(existsSync(join(out, 'b.xml'))).toBe(false);
            expect(existsSync(join(out, 'sub'))).toBe(false);
        });

        it('reproduces the tree under -o', () => {
            const src = tree();
            const out = join(dir, 'out');
            const res = svgvd(src, '-r', '-o', out);
            expect(res.status).toBe(0);
            expect(existsSync(join(out, 'a.xml'))).toBe(true);
            expect(existsSync(join(out, 'sub', 'b.xml'))).toBe(true);
            expect(existsSync(join(out, 'sub', 'deep', 'c.xml'))).toBe(true);
            expect(existsSync(join(out, 'sub', 'notes.xml'))).toBe(false);
            expect(res.stderr).toContain(
                `✓ ${join(src, 'sub', 'deep', 'c.SVG')} → ${join(out, 'sub', 'deep', 'c.xml')}`,
            );
        });

        it('writes next to each input without -o', () => {
            const src = tree();
            expect(svgvd(src, '--recursive').status).toBe(0);
            expect(existsSync(join(src, 'sub', 'b.xml'))).toBe(true);
            expect(existsSync(join(src, 'sub', 'deep', 'c.xml'))).toBe(true);
        });

        it('flattens the outputs with --android-names (a resource directory has no subdirectories)', () => {
            const src = tree();
            writeFileSync(join(src, 'sub', 'Arrow-Left.svg'), ICON);
            const out = join(dir, 'out');
            const res = svgvd(src, '-r', '-o', out, '--android-names');
            expect(res.status).toBe(0);
            for (const name of ['a', 'b', 'c', 'arrow_left']) expect(existsSync(join(out, `${name}.xml`))).toBe(true);
            expect(existsSync(join(out, 'sub'))).toBe(false);
        });

        it('detects a resource name collision across subdirectories before writing anything', () => {
            const src = tree();
            mkdirSync(join(src, 'other'));
            writeFileSync(join(src, 'other', 'B.svg'), ICON);
            const out = join(dir, 'out');
            const res = svgvd(src, '-r', '-o', out, '--android-names');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain(`b.xml: ${join(src, 'other', 'B.svg')}, ${join(src, 'sub', 'b.svg')}`);
            expect(existsSync(out)).toBe(false);
        });

        it('does not follow a symbolic link to a directory', () => {
            const src = tree();
            symlinkSync(src, join(src, 'sub', 'loop'), 'dir');
            const res = svgvd(src, '-r', '--dry-run', '--json');
            expect(res.status).toBe(0);
            expect(parseReport(res.stdout)).toHaveLength(3);
        });
    });

    describe('--json', () => {
        it('reports every file and exits 1 when one fails', () => {
            const src = join(dir, 'src');
            mkdirSync(src);
            writeFileSync(join(src, 'dashed.svg'), DASHED);
            writeFileSync(join(src, 'icon.svg'), ICON);
            writeFileSync(join(src, 'invalid.svg'), 'not svg');
            const out = join(dir, 'out');
            const res = svgvd(src, join(dir, 'nope.svg'), '-o', out, '--json', '--rule', 'min-sdk-exceeded=warn');
            expect(res.status).toBe(1);
            expect(parseReport(res.stdout)).toEqual([
                {
                    input: join(dir, 'nope.svg'),
                    output: null,
                    warnings: [],
                    minSdk: null,
                    error: { message: 'no such file or directory' },
                    fallback: null,
                },
                {
                    input: join(src, 'dashed.svg'),
                    output: join(out, 'dashed.xml'),
                    warnings: [expect.objectContaining({ code: 'unsupported-stroke-dasharray', category: 'lossy' })],
                    minSdk: 21,
                    error: null,
                    fallback: null,
                },
                {
                    input: join(src, 'icon.svg'),
                    output: join(out, 'icon.xml'),
                    warnings: [],
                    minSdk: 21,
                    error: null,
                    fallback: null,
                },
                {
                    input: join(src, 'invalid.svg'),
                    output: null,
                    warnings: [],
                    minSdk: null,
                    error: { message: expect.stringMatching(/^Invalid SVG/) },
                    fallback: null,
                },
            ]);
            expect(existsSync(join(out, 'icon.xml'))).toBe(true);
            // Human-readable lines stay on stderr.
            expect(res.stderr).toContain('✓');
        });

        it('exits 0 when every file converts', () => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            const res = svgvd(input, '--json');
            expect(res.status).toBe(0);
            expect(parseReport(res.stdout)).toEqual([
                { input, output: join(dir, 'icon.xml'), warnings: [], minSdk: 21, error: null, fallback: null },
            ]);
        });

        it('carries the code and category of an escalated warning', () => {
            const input = join(dir, 'dashed.svg');
            writeFileSync(input, DASHED);
            const res = svgvd(input, '--strict', '--json');
            expect(res.status).toBe(1);
            expect(parseReport(res.stdout)[0]!.error).toEqual({
                message: expect.stringMatching(/^\[unsupported-stroke-dasharray\] /),
                code: 'unsupported-stroke-dasharray',
                category: 'lossy',
            });
        });

        it('reports stdin as "-" and -s as null', () => {
            const target = join(dir, 'out.xml');
            const stdin = svgvdStdin(ICON, ['-', '-o', target, '--json']);
            expect(stdin.status).toBe(0);
            expect(parseReport(stdin.stdout)).toEqual([
                { input: '-', output: target, warnings: [], minSdk: 21, error: null, fallback: null },
            ]);
            const inline = svgvd('-s', ICON, '--json', '--dry-run');
            expect(inline.status).toBe(0);
            expect(parseReport(inline.stdout)).toEqual([
                { input: null, output: null, warnings: [], minSdk: 21, error: null, fallback: null },
            ]);
        });

        it('reports a resource name collision as JSON', () => {
            const src = join(dir, 'src');
            mkdirSync(src);
            writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
            writeFileSync(join(src, 'arrow_left.svg'), ICON);
            writeFileSync(join(src, 'other.svg'), ICON);
            const out = join(dir, 'out');
            const res = svgvd(src, '-o', out, '--android-names', '--json');
            expect(res.status).toBe(1);
            const report = parseReport(res.stdout);
            expect(report.map((e) => e.input)).toEqual([
                join(src, 'Arrow-Left.svg'),
                join(src, 'arrow_left.svg'),
                join(src, 'other.svg'),
            ]);
            expect(report.every((e) => e.error !== null && e.output === null)).toBe(true);
            expect(report[0]!.error!.message).toContain('collision');
            expect(existsSync(out)).toBe(false);
        });

        it.each([[['-s', ICON]], [['-', '-o', 'out/']], [['FILE', '--stdout']]])(
            'refuses to mix the report with XML on stdout (%j)',
            (args) => {
                const input = join(dir, 'icon.svg');
                writeFileSync(input, ICON);
                const res = svgvdStdin(ICON, [...args.map((a) => (a === 'FILE' ? input : a)), '--json']);
                expect(res.status).toBe(1);
                expect(res.stdout).toBe('');
                expect(res.stderr).toContain('--json prints the report on stdout');
                expect(res.reads).toBe(0);
            },
        );
    });

    describe('--dry-run', () => {
        it('converts and reports without writing', () => {
            const src = join(dir, 'src');
            mkdirSync(join(src, 'sub'), { recursive: true });
            writeFileSync(join(src, 'a.svg'), ICON);
            writeFileSync(join(src, 'sub', 'b.svg'), ICON);
            const out = join(dir, 'out');
            const res = svgvd(src, '-r', '-o', out, '--dry-run', '--json');
            expect(res.status).toBe(0);
            expect(parseReport(res.stdout).map((e) => e.output)).toEqual([
                join(out, 'a.xml'),
                join(out, 'sub', 'b.xml'),
            ]);
            expect(res.stderr).toContain(`✓ ${join(src, 'a.svg')} → ${join(out, 'a.xml')} (dry run)`);
            expect(existsSync(out)).toBe(false);
        });

        it('still fails on a conversion error', () => {
            const input = join(dir, 'dashed.svg');
            writeFileSync(input, DASHED);
            expect(svgvd(input, '--strict', '--dry-run').status).toBe(1);
        });

        it('prints no XML for stdout targets', () => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            expect(svgvd(input, '--stdout', '--dry-run').stdout).toBe('');
            expect(svgvd('-s', ICON, '--dry-run').stdout).toBe('');
            expect(svgvdStdin(ICON, ['-', '--dry-run']).stdout).toBe('');
            expect(existsSync(join(dir, 'icon.xml'))).toBe(false);
        });

        it('documents the options in the help', () => {
            const help = svgvd('--help').stdout;
            for (const flag of ['--recursive', '--json', '--dry-run', 'svgvd -']) expect(help).toContain(flag);
        });
    });

    describe('--fallback-png', () => {
        /** Width and height of a PNG file, from its IHDR chunk. */
        const pngSize = (path: string): [number, number] => {
            const png = readFileSync(path);
            return [png.readUInt32BE(16), png.readUInt32BE(20)];
        };

        /** A source directory with a rejected (filter) and a convertible SVG. */
        function sources(): string {
            const src = join(dir, 'src');
            mkdirSync(src);
            writeFileSync(join(src, 'blur.svg'), BLUR);
            writeFileSync(join(src, 'icon.svg'), ICON);
            return src;
        }

        it('renders a rejected SVG to one PNG per density, without XML, and converts the others', () => {
            const out = join(dir, 'out');
            const res = svgvd(sources(), '-o', out, '--strict', '--fallback-png', 'all', '--json');
            expect(res.status).toBe(0);
            expect(readdirSync(out).sort()).toEqual([...DENSITY_DIRS, 'icon.xml']);
            expect(DENSITY_DIRS.map((d) => readdirSync(join(out, d)))).toEqual(DENSITY_DIRS.map(() => ['blur.png']));
            expect(
                ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].map((d) =>
                    pngSize(join(out, `drawable-${d}`, 'blur.png')),
                ),
            ).toEqual([
                [24, 24],
                [36, 36],
                [48, 48],
                [72, 72],
                [96, 96],
            ]);
            const [blur, icon] = parseReport(res.stdout);
            expect(blur).toEqual({
                input: join(dir, 'src', 'blur.svg'),
                output: null,
                warnings: [],
                minSdk: null,
                error: null,
                fallback: {
                    outputs: ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].map((d) =>
                        join(out, `drawable-${d}`, 'blur.png'),
                    ),
                    reason: expect.objectContaining({ code: 'unsupported-attribute', category: 'lossy' }),
                },
            });
            expect(icon).toMatchObject({ output: join(out, 'icon.xml'), fallback: null });
            expect(res.stderr).toContain(
                `→ ${join(out, 'drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}', 'blur.png')} (PNG fallback: [unsupported-attribute]`,
            );
        });

        it('writes beside an Android drawable directory, with the resource name', () => {
            const src = join(dir, 'src');
            mkdirSync(src);
            writeFileSync(join(src, 'Soft-Blur.svg'), BLUR);
            const res = join(dir, 'res');
            const status = svgvd(
                src,
                '-o',
                join(res, 'drawable'),
                '--android-names',
                '--strict',
                '--fallback-png',
                'xhdpi,mdpi',
            ).status;
            expect(status).toBe(0);
            expect(readdirSync(res).sort()).toEqual(['drawable-mdpi', 'drawable-xhdpi']);
            expect(pngSize(join(res, 'drawable-xhdpi', 'soft_blur.png'))).toEqual([48, 48]);
        });

        it('follows --width / --height, and renders a single source next to -o file.xml', () => {
            const target = join(dir, 'out', 'blur.xml');
            const res = svgvdStdin(BLUR, ['-', '-o', target, '--strict', '--width', '48', '--fallback-png', 'hdpi']);
            expect(res.status).toBe(0);
            expect(pngSize(join(dir, 'out', 'drawable-hdpi', 'blur.png'))).toEqual([72, 72]);
            expect(existsSync(target)).toBe(false);
        });

        it('writes no PNG when the conversion succeeds, even lossy', () => {
            const input = join(dir, 'blur.svg');
            writeFileSync(input, BLUR);
            const res = svgvd(input, '--fallback-png', 'all');
            expect(res.status).toBe(0);
            expect(res.stderr).toContain('[unsupported-attribute]');
            expect(readdirSync(dir).sort()).toEqual(['blur.svg', 'blur.xml']);
        });

        it('does not fall back on an invalid SVG', () => {
            const input = join(dir, 'invalid.svg');
            writeFileSync(input, 'not svg');
            const res = svgvd(input, '--strict', '--fallback-png', 'all', '--json', '--dry-run');
            expect(res.status).toBe(1);
            expect(parseReport(res.stdout)[0]).toMatchObject({
                error: { message: expect.stringMatching(/^Invalid SVG/) },
                fallback: null,
            });
        });

        it('reports the PNGs without writing them with --dry-run', () => {
            const out = join(dir, 'out');
            const res = svgvd(sources(), '-o', out, '--strict', '--fallback-png', 'mdpi', '--dry-run', '--json');
            expect(res.status).toBe(0);
            expect(parseReport(res.stdout)[0]!.fallback!.outputs).toEqual([join(out, 'drawable-mdpi', 'blur.png')]);
            expect(res.stderr).toContain('blur.png (dry run)');
            expect(existsSync(out)).toBe(false);
        });

        it.each([
            [['-s', ICON], '--fallback-png writes PNG files'],
            [['FILE', '--stdout'], '--fallback-png writes PNG files'],
            [['FILE', '--fallback-png'], 'Missing value for --fallback-png'],
        ])('refuses %j', (args, message) => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            const res = svgvd(
                ...args.map((a) => (a === 'FILE' ? input : a)),
                ...(args.includes('--fallback-png') ? [] : ['--fallback-png', 'all']),
            );
            expect(res.status).toBe(1);
            expect(res.stderr).toContain(message);
        });

        it('rejects an unknown density', () => {
            const res = svgvd('-s', ICON, '--fallback-png', 'mdpi,ldpi');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain(
                'Invalid --fallback-png (expected all, or a comma list of mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi): mdpi,ldpi',
            );
        });

        it('documents the option in the help', () => {
            expect(svgvd('--help').stdout).toContain('--fallback-png <d>');
        });

        describe('without @resvg/resvg-js', () => {
            afterEach(() => {
                vi.doUnmock('node:module');
                vi.resetModules();
            });

            it('fails the rejected file with a one-line message and exit code 1, converting the others', async () => {
                vi.resetModules();
                vi.doMock('node:module', async (importOriginal) => ({
                    ...(await importOriginal<typeof import('node:module')>()),
                    createRequire: () => (id: string) => {
                        throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
                    },
                }));
                const cli = await import('../src/cli.js');
                let stderr = '';
                const out = join(dir, 'out');
                const status = cli.run([sources(), '-o', out, '--strict', '--fallback-png', 'all'], {
                    stdout: () => {},
                    stderr: (text) => (stderr += text),
                });
                expect(status).toBe(1);
                expect(stderr).toContain(
                    `✗ ${join(dir, 'src', 'blur.svg')}: [unsupported-attribute] filter on <path> cannot be represented in a VectorDrawable; ignored. PNG fallback failed: The PNG fallback needs @resvg/resvg-js, which is not installed: npm install @resvg/resvg-js\n`,
                );
                expect(readdirSync(out)).toEqual(['icon.xml']);
            });
        });
    });
});
