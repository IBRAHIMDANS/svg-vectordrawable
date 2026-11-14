import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    type FSWatcher,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type CliIo, type ReportEntry } from '../src/cli.js';
import { convert } from '../src/convert.js';

/** The watchers `--watch` opened (closed or not), and an error to make `fs.watch` throw. */
const watched = vi.hoisted(() => ({
    watchers: [] as { closed: boolean }[],
    failure: undefined as Error | undefined,
}));

// fs.watch, recorded: --watch must close every watcher it opens.
vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    const watch = ((...args: unknown[]): FSWatcher => {
        if (watched.failure) throw watched.failure;
        const watcher = (fs.watch as (...a: unknown[]) => FSWatcher)(...args);
        const entry = { closed: false };
        watcher.on('close', () => (entry.closed = true));
        watched.watchers.push(entry);
        return watcher;
    }) as typeof fs.watch;
    return { ...fs, watch, default: { ...fs, watch } };
});

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
    if (typeof status !== 'number') throw new Error('unexpected --watch session');
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

    describe('output collisions without --android-names', () => {
        it('fails before writing anything when a.svg and a.SVG share a directory', () => {
            const src = join(dir, 'src');
            mkdirSync(src);
            writeFileSync(join(src, 'a.svg'), ICON);
            writeFileSync(join(src, 'a.SVG'), ICON);
            const out = join(dir, 'out');
            const res = svgvd(src, '-o', out);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain(
                `✗ Output collision (nothing written):\n  ${join(out, 'a.xml')}: ${join(src, 'a.SVG')}, ${join(src, 'a.svg')}\n`,
            );
            expect(existsSync(out)).toBe(false);
        });

        it('fails when two inputs of the same name go to one directory, with every file failed in --json', () => {
            for (const sub of ['x', 'y']) {
                mkdirSync(join(dir, sub));
                writeFileSync(join(dir, sub, 'a.svg'), ICON);
            }
            writeFileSync(join(dir, 'b.svg'), ICON);
            const out = join(dir, 'out');
            const inputs = [join(dir, 'x', 'a.svg'), join(dir, 'y', 'a.svg'), join(dir, 'b.svg')];
            const res = svgvd(...inputs, '-o', out, '--json', '--fallback-png', 'mdpi');
            expect(res.status).toBe(1);
            const report = JSON.parse(res.stdout) as ReportEntry[];
            expect(report.map((e) => [e.input, e.output, e.error?.message])).toEqual([
                [
                    inputs[0],
                    null,
                    `Output collision (nothing written): ${join(out, 'a.xml')} ← ${inputs[0]}, ${inputs[1]}`,
                ],
                [
                    inputs[1],
                    null,
                    `Output collision (nothing written): ${join(out, 'a.xml')} ← ${inputs[0]}, ${inputs[1]}`,
                ],
                [inputs[2], null, 'Not converted: Output collision in this batch (nothing written)'],
            ]);
            expect(existsSync(out)).toBe(false);
        });

        it('accepts the same file name in distinct output directories', () => {
            for (const sub of ['x', 'y']) {
                mkdirSync(join(dir, sub));
                writeFileSync(join(dir, sub, 'a.svg'), ICON);
            }
            expect(svgvd(join(dir, 'x', 'a.svg'), join(dir, 'y', 'a.svg')).status).toBe(0);
            expect(existsSync(join(dir, 'x', 'a.xml')) && existsSync(join(dir, 'y', 'a.xml'))).toBe(true);
        });
    });

    describe('--font', () => {
        const FONT = new URL('./fixtures-fonts/Quicksand-Regular.ttf', import.meta.url).pathname;
        const TEXT =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><text x="5" y="28" font-family="Quicksand" font-size="20">Hi</text></svg>';

        it('draws a <text> in the given family as glyph outlines', () => {
            const res = svgvd('-s', TEXT, '--font', `quicksand=${FONT}`, '--json', '--dry-run');
            expect(res.status).toBe(0);
            const [entry] = JSON.parse(res.stdout) as ReportEntry[];
            expect(entry!.warnings.map((w) => w.code)).not.toContain('unsupported-element');
            expect(svgvd('-s', TEXT, '--font', `Quicksand=${FONT}`).stdout).toBe(
                convert(TEXT, { fonts: { Quicksand: FONT } }).xml,
            );
        });

        it('keeps <text> unconverted without a font for its family', () => {
            const res = svgvd('-s', TEXT, '--font', `Inter=${FONT}`, '--json', '--dry-run');
            const [entry] = JSON.parse(res.stdout) as ReportEntry[];
            expect(entry!.warnings.map((w) => w.code)).toContain('unsupported-element');
        });

        it.each(['Quicksand', '=font.ttf', 'Quicksand='])('rejects --font %j', (value) => {
            const res = svgvd('-s', TEXT, '--font', value);
            expect(res.status).toBe(1);
            expect(res.stderr).toBe(`Invalid --font (expected <family>=<file>): ${value}\n`);
        });

        it('documents the option in the help', () => {
            expect(svgvd('--help').stdout).toContain('--font <f=file>');
        });
    });

    it('exports package.json', () => {
        const pkg = createRequire(import.meta.url)('svg-vectordrawable/package.json') as { name: string };
        expect(pkg.name).toBe('svg-vectordrawable');
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
        // Crossing contours: below API 24, only those keep android:fillType (nested ones become nonzero).
        const EVEN_ODD =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
            '<path d="M2 2h12v12H2zM8 8h12v12H8z" fill-rule="evenodd"/></svg>';

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

    describe('--preserve-ids', () => {
        const named =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g id="arm"><path id="hand" d="M0 0h4v4z"/></g></svg>';

        it('emits ids as android:name only with --preserve-ids', () => {
            const out = svgvd('-s', named, '--preserve-ids').stdout;
            expect(out).toContain('<group\n        android:name="arm">');
            expect(out).toContain('android:name="hand"');
            expect(svgvd('-s', named).stdout).not.toContain('android:name');
        });

        it('is listed in --help', () => {
            expect(svgvd('--help').stdout).toContain('--preserve-ids');
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

        describe('stale outputs of the other form', () => {
            let input: string;
            const xml = (): string => join(dir, 'blur.xml');
            const png = (density: string): string => join(dir, `drawable-${density}`, 'blur.png');

            beforeEach(() => {
                input = join(dir, 'blur.svg');
                writeFileSync(input, BLUR);
            });

            it('deletes the PNGs of every density when the XML is written, and nothing else', () => {
                const first = svgvd(input, '--strict', '--fallback-png', 'mdpi,xhdpi');
                expect(first.status).toBe(0);
                expect(first.stderr).not.toContain('deleted');
                writeFileSync(join(dir, 'drawable-mdpi', 'other.png'), 'kept');
                writeFileSync(join(dir, 'drawable-mdpi', 'blur.webp'), 'kept');
                // Fixed (no --strict), and converted with another density list than the first run.
                const res = svgvd(input, '--fallback-png', 'hdpi');
                expect(res.status).toBe(0);
                expect(existsSync(xml())).toBe(true);
                expect(existsSync(png('mdpi'))).toBe(false);
                expect(existsSync(png('xhdpi'))).toBe(false);
                expect(readdirSync(join(dir, 'drawable-mdpi')).sort()).toEqual(['blur.webp', 'other.png']);
                expect(res.stderr).toContain(`✓ ${input} → ${png('mdpi')} deleted (stale PNG fallback)\n`);
                expect(res.stderr).toContain(`✓ ${input} → ${png('xhdpi')} deleted (stale PNG fallback)\n`);
                expect(res.stderr.match(/deleted/g)).toHaveLength(2);
            });

            it('deletes the XML when the PNGs are written', () => {
                expect(svgvd(input).status).toBe(0);
                expect(existsSync(xml())).toBe(true);
                const res = svgvd(input, '--strict', '--fallback-png', 'mdpi');
                expect(res.status).toBe(0);
                expect(existsSync(xml())).toBe(false);
                expect(existsSync(png('mdpi'))).toBe(true);
                expect(res.stderr).toContain(`✓ ${input} → ${xml()} deleted (stale XML)\n`);
            });

            it('deletes nothing with --dry-run, saying what would be deleted', () => {
                expect(svgvd(input, '--strict', '--fallback-png', 'mdpi').status).toBe(0);
                const res = svgvd(input, '--dry-run');
                expect(res.status).toBe(0);
                expect(existsSync(png('mdpi'))).toBe(true);
                expect(existsSync(xml())).toBe(false);
                expect(res.stderr).toContain(`✓ ${input} → ${png('mdpi')} deleted (dry run) (stale PNG fallback)\n`);
            });

            it('`all` then `mdpi` → only drawable-mdpi/ remains', () => {
                expect(svgvd(input, '--strict', '--fallback-png', 'all').status).toBe(0);
                const res = svgvd(input, '--strict', '--fallback-png', 'mdpi');
                expect(res.status).toBe(0);
                expect(DENSITY_DIRS.filter((d) => existsSync(join(dir, d, 'blur.png')))).toEqual(['drawable-mdpi']);
                for (const density of ['hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'])
                    expect(res.stderr).toContain(`✓ ${input} → ${png(density)} deleted (stale PNG fallback)\n`);
                expect(res.stderr.match(/deleted/g)).toHaveLength(4);
            });

            it('keeps the PNGs of densities no longer requested with --dry-run', () => {
                expect(svgvd(input, '--strict', '--fallback-png', 'mdpi,hdpi').status).toBe(0);
                const res = svgvd(input, '--strict', '--fallback-png', 'mdpi', '--dry-run');
                expect(res.status).toBe(0);
                expect(existsSync(png('hdpi'))).toBe(true);
                expect(res.stderr).toContain(`✓ ${input} → ${png('hdpi')} deleted (dry run) (stale PNG fallback)\n`);
            });

            it('says nothing when there is no earlier output', () => {
                const res = svgvd(input);
                expect(res.status).toBe(0);
                expect(res.stderr).not.toContain('deleted');
            });
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

    describe('--format compose', () => {
        it('writes <KotlinName>.kt with the package, named from the file name', () => {
            const input = join(dir, 'arrow-left.svg');
            writeFileSync(input, ICON);
            const res = svgvd(input, '--format', 'compose', '--package', 'com.example.icons');
            expect(res.status).toBe(0);
            const kotlin = readFileSync(join(dir, 'ArrowLeft.kt'), 'utf8');
            expect(kotlin).toMatch(/^package com\.example\.icons\n/);
            expect(kotlin).toContain('val ArrowLeft: ImageVector by lazy {');
            expect(kotlin).toContain('fill = SolidColor(Color(0xFFFF0000))');
            expect(existsSync(join(dir, 'arrow-left.xml'))).toBe(false);
        });

        it('writes a directory flat into -o, failing on two inputs with one Kotlin name', () => {
            const src = join(dir, 'src');
            mkdirSync(join(src, 'sub'), { recursive: true });
            writeFileSync(join(src, 'a-b.svg'), ICON);
            writeFileSync(join(src, 'sub', 'c.svg'), ICON);
            const out = join(dir, 'out');
            expect(svgvd(src, '-r', '-o', out, '--format', 'compose').status).toBe(0);
            expect(readdirSync(out).sort()).toEqual(['AB.kt', 'C.kt']);
            writeFileSync(join(src, 'a_b.svg'), ICON);
            const res = svgvd(src, '-o', join(dir, 'out2'), '--format', 'compose');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('AB.kt');
            expect(existsSync(join(dir, 'out2'))).toBe(false);
        });

        it('fails on Kotlin names differing only by case, with every file failed in --json', () => {
            const inputs = [join(dir, 'ab.svg'), join(dir, 'a-b.svg')]; // Ab.kt, AB.kt
            for (const input of inputs) writeFileSync(input, ICON);
            const out = join(dir, 'out');
            const message = `Kotlin name collision (nothing written): ${join(out, 'Ab.kt')}, ${join(out, 'AB.kt')} ← ${inputs[0]}, ${inputs[1]}`;
            const res = svgvd(...inputs, '-o', out, '--format', 'compose', '--json');
            expect(res.status).toBe(1);
            expect(parseReport(res.stdout).map((e) => [e.input, e.output, e.error?.message])).toEqual([
                [inputs[0], null, message],
                [inputs[1], null, message],
            ]);
            expect(existsSync(out)).toBe(false);
            const text = svgvd(...inputs, '-o', out, '--format', 'compose');
            expect(text.status).toBe(1);
            expect(text.stderr).toContain(
                `✗ Kotlin name collision (nothing written):\n  ${join(out, 'Ab.kt')}, ${join(out, 'AB.kt')}:`,
            );
            expect(existsSync(out)).toBe(false);
        });

        it('prints -s / stdin as val Icon, or names it after -o Name.kt', () => {
            const res = svgvd('-s', ICON, '--format', 'compose');
            expect(res.status).toBe(0);
            expect(res.stdout).toContain('val Icon: ImageVector');
            expect(res.stdout).not.toContain('package ');
            const target = join(dir, 'Brand.kt');
            expect(svgvdStdin(ICON, ['-', '-o', target, '--format', 'compose']).status).toBe(0);
            expect(readFileSync(target, 'utf8')).toContain('val Brand: ImageVector');
        });

        it('reports warnings and fails under --strict like the XML output', () => {
            const input = join(dir, 'dashed.svg');
            writeFileSync(input, DASHED);
            const ok = svgvd(input, '--format', 'compose');
            expect(ok.status).toBe(0);
            expect(ok.stderr).toContain('[unsupported-stroke-dasharray]');
            rmSync(join(dir, 'Dashed.kt'));
            const res = svgvd(input, '--format', 'compose', '--strict');
            expect(res.status).toBe(1);
            expect(existsSync(join(dir, 'Dashed.kt'))).toBe(false);
        });

        it('reports a color reference it cannot express (unsupported-color-reference)', () => {
            const res = svgvd('-s', ICON, '--format', 'compose', '--color-map', '#f00=@color/brand');
            expect(res.status).toBe(0);
            expect(res.stderr).toContain('[unsupported-color-reference] The color reference @color/brand');
            expect(res.stdout).toContain('Color(0xFF808080)');
        });

        it('has a null minSdk in the --json report', () => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            const res = svgvd(input, '--format', 'compose', '--json');
            expect(res.status).toBe(0);
            expect(parseReport(res.stdout)).toMatchObject([
                { input, output: join(dir, 'Icon.kt'), minSdk: null, error: null },
            ]);
        });

        it.each([
            [['--format', 'png'], 'Invalid --format (expected vector, compose or svg): png'],
            [['--package', 'com.example'], '--package needs --format compose'],
            [['--format', 'compose', '--package', 'com..x'], 'Invalid --package'],
            [['--format', 'compose', '--min-sdk', '21'], '--min-sdk cannot be combined with --format compose'],
            [['--format', 'compose', '--xml-tag'], '--xml-tag cannot be combined with --format compose'],
            [
                ['--format', 'compose', '--fallback-png', 'all'],
                '--fallback-png cannot be combined with --format compose',
            ],
        ])('rejects %j', (args, message) => {
            const res = svgvd('-s', ICON, ...args);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain(message);
        });

        it('documents the options in the help', () => {
            const help = svgvd('--help').stdout;
            expect(help).toContain('--format <f>');
            expect(help).toContain('--package <name>');
        });
    });

    describe('VectorDrawable input (T-181)', () => {
        /** An Android Studio style drawable: XML declaration, comment, trim path, tint mode, color reference. */
        const FOREIGN =
            '<?xml version="1.0" encoding="utf-8"?>\n<!-- icon -->\n' +
            '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" ' +
            'android:viewportWidth="24" android:viewportHeight="24" android:tint="?attr/colorControlNormal" android:tintMode="multiply">' +
            '<path android:name="ring" android:pathData="M12,2A10,10 0 1,1 11.99,2Z" android:strokeColor="#F00" android:strokeWidth="2" ' +
            'android:trimPathStart="0.1" android:trimPathEnd="0.8"/></vector>';

        /** Converts `ICON` to `<dir>/vd/arrow-left.xml` and returns that path. */
        function drawable(): string {
            const svg = join(dir, 'arrow-left.svg');
            writeFileSync(svg, ICON);
            expect(svgvd(svg, '-o', join(dir, 'vd')).status).toBe(0);
            return join(dir, 'vd', 'arrow-left.xml');
        }

        it('--format compose gives the same Kotlin from a drawable as from its SVG', () => {
            const xml = drawable();
            expect(svgvd(join(dir, 'arrow-left.svg'), '-o', join(dir, 'a'), '--format', 'compose').status).toBe(0);
            const res = svgvd(xml, '-o', join(dir, 'b'), '--format', 'compose');
            expect(res.status).toBe(0);
            expect(readFileSync(join(dir, 'b', 'ArrowLeft.kt'), 'utf8')).toBe(
                readFileSync(join(dir, 'a', 'ArrowLeft.kt'), 'utf8'),
            );
        });

        it('--format compose reads a drawable from stdin and -s, and keeps what only a drawable has', () => {
            const piped = svgvdStdin(FOREIGN, ['--format', 'compose']);
            expect(piped.status).toBe(0);
            expect(piped.stdout).toContain('trimPathStart = 0.1f');
            expect(piped.stdout).toContain('trimPathEnd = 0.8f');
            expect(piped.stdout).toContain('name = "ring"');
            expect(piped.stderr).toContain('[unsupported-attribute] android:tintMode on <vector>');
            expect(piped.stderr).toContain('[unsupported-color-reference]');
            expect(svgvd('-s', FOREIGN, '--format', 'compose').stdout).toBe(piped.stdout);
        });

        it('--format compose --strict rejects a drawable with an attribute it cannot express', () => {
            const res = svgvdStdin(FOREIGN, ['--format', 'compose', '--strict']);
            expect(res.status).toBe(1);
            expect(res.stdout).toBe('');
            expect(res.stderr).toContain('android:tintMode');
        });

        it('--format compose says so when an .xml input is not a VectorDrawable', () => {
            const input = join(dir, 'selector.xml');
            writeFileSync(input, '<selector xmlns:android="http://schemas.android.com/apk/res/android"/>');
            const res = svgvd(input, '--format', 'compose', '--stdout');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('Not a VectorDrawable: the root element is not <vector>');
        });

        it('--format svg writes <name>.svg, and converts the *.xml of a directory', () => {
            const xml = drawable();
            const res = svgvd(xml, '--format', 'svg');
            expect(res.status).toBe(0);
            const svg = readFileSync(join(dir, 'vd', 'arrow-left.svg'), 'utf8');
            expect(svg).toMatch(
                /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24"/,
            );
            expect(svg).toContain('fill="#ff0000"');

            writeFileSync(join(dir, 'vd', 'notes.txt'), 'not an input');
            const out = join(dir, 'out');
            expect(svgvd(join(dir, 'vd'), '--format', 'svg', '-o', out).status).toBe(0);
            expect(readdirSync(out)).toEqual(['arrow-left.svg']);
        });

        it('--format svg reads stdin, and says what the SVG does not carry over', () => {
            const res = svgvdStdin(FOREIGN, ['--format', 'svg']);
            expect(res.status).toBe(0);
            expect(res.stdout).toContain('<svg ');
            expect(res.stderr).toContain('android:trimPath* is not converted');
            expect(res.stderr).toContain('android:tint is not applied');
        });

        it('--format svg fails on an SVG input and on a conversion option', () => {
            const input = join(dir, 'icon.svg');
            writeFileSync(input, ICON);
            const notVector = svgvd(input, '--format', 'svg', '--stdout');
            expect(notVector.status).toBe(1);
            expect(notVector.stderr).toContain('Root element is <svg>, expected <vector>');

            const option = svgvd(drawable(), '--format', 'svg', '--strict', '--tint', '#f00');
            expect(option.status).toBe(1);
            expect(option.stderr).toContain('--format svg takes no conversion option (given: strict, tint)');
        });

        it('--format vector still reads a directory for its *.svg only', () => {
            drawable();
            const res = svgvd(join(dir, 'vd'), '-o', join(dir, 'again'));
            expect(existsSync(join(dir, 'again'))).toBe(false);
            expect(res.stderr).not.toContain('✓');
        });
    });

    describe('--watch', () => {
        const BLUE = ICON.replace('#f00', '#00f');
        let src: string;
        let out: string;

        /** Starts `svgvd --watch …args` in-process; `stop` sends SIGINT and returns the exit code. */
        function watchSvgvd(...args: string[]) {
            const io = { stdout: '', stderr: '' };
            const status = run(['--watch', ...args], {
                stdout: (text) => (io.stdout += text),
                stderr: (text) => (io.stderr += text),
            });
            if (typeof status === 'number') throw new Error(`--watch did not start (${status}): ${io.stderr}`);
            return {
                io,
                /** The exit code, when the session ends on its own. */
                done: status,
                stop: (): Promise<number> => {
                    process.emit('SIGINT');
                    return status;
                },
            };
        }

        /** Retries `assertion` until it passes, for at most 5 s (file events are asynchronous). */
        const eventually = (assertion: () => void): Promise<void> =>
            vi.waitFor(assertion, { timeout: 5000, interval: 20 });

        const read = (path: string): string => readFileSync(path, 'utf8');

        beforeEach(() => {
            src = join(dir, 'src');
            out = join(dir, 'out');
            mkdirSync(src);
            writeFileSync(join(src, 'a.svg'), ICON);
            watched.watchers.length = 0;
            watched.failure = undefined;
        });

        afterEach(() => {
            process.emit('SIGINT'); // stops a session a failed test left running
            watched.failure = undefined;
        });

        it('converts everything at start, then a changed file again', async () => {
            const session = watchSvgvd(src, '-o', out);
            expect(read(join(out, 'a.xml'))).toBe(convert(ICON).xml);
            expect(session.io.stderr).toContain(`Watching ${src} for changes`);
            writeFileSync(join(src, 'a.svg'), BLUE);
            await eventually(() => expect(read(join(out, 'a.xml'))).toBe(convert(BLUE).xml));
            expect(await session.stop()).toBe(0);
        });

        it('converts an added file, and ignores files that are not SVG', async () => {
            const session = watchSvgvd(src, '-o', out);
            writeFileSync(join(src, 'notes.txt'), 'not an icon');
            writeFileSync(join(src, 'b.svg'), BLUE);
            await eventually(() => expect(read(join(out, 'b.xml'))).toBe(convert(BLUE).xml));
            expect(readdirSync(out).sort()).toEqual(['a.xml', 'b.xml']);
            await session.stop();
        });

        it('deletes the output of a removed file', async () => {
            const session = watchSvgvd(src, '-o', out);
            rmSync(join(src, 'a.svg'));
            await eventually(() => expect(existsSync(join(out, 'a.xml'))).toBe(false));
            expect(session.io.stderr).toContain(`✓ ${join(src, 'a.svg')} removed → ${join(out, 'a.xml')} deleted\n`);
            await session.stop();
        });

        it('skips a directory at the output of a removed file, and keeps watching', async () => {
            const session = watchSvgvd(src, '-o', out);
            rmSync(join(out, 'a.xml'));
            mkdirSync(join(out, 'a.xml'));
            rmSync(join(src, 'a.svg'));
            await eventually(() =>
                expect(session.io.stderr).toContain(
                    `  ⚠ ${join(src, 'a.svg')} removed did not delete ${join(out, 'a.xml')}: it is a directory\n`,
                ),
            );
            expect(existsSync(join(out, 'a.xml'))).toBe(true);
            writeFileSync(join(src, 'b.svg'), BLUE);
            await eventually(() => expect(read(join(out, 'b.xml'))).toBe(convert(BLUE).xml));
            expect(await session.stop()).toBe(0);
        });

        it('replaces the XML by the PNG fallback and back, deleting the stale form', async () => {
            const session = watchSvgvd(src, '-o', out, '--strict', '--fallback-png', 'mdpi');
            const xml = join(out, 'a.xml');
            const png = join(out, 'drawable-mdpi', 'a.png');
            expect(existsSync(xml)).toBe(true);
            writeFileSync(join(src, 'a.svg'), BLUR);
            await eventually(() => expect(existsSync(xml)).toBe(false));
            expect(existsSync(png)).toBe(true);
            expect(session.io.stderr).toContain(`✓ ${join(src, 'a.svg')} → ${xml} deleted (stale XML)\n`);
            writeFileSync(join(src, 'a.svg'), BLUE);
            await eventually(() => expect(existsSync(png)).toBe(false));
            expect(read(xml)).toBe(convert(BLUE, { strict: true }).xml);
            await session.stop();
        });

        it('--watch: deleting the SVG → no PNG left, whatever the densities of earlier runs', async () => {
            writeFileSync(join(src, 'a.svg'), BLUR);
            expect(svgvd(src, '-o', out, '--strict', '--fallback-png', 'all').status).toBe(0);
            const session = watchSvgvd(src, '-o', out, '--strict', '--fallback-png', 'mdpi');
            rmSync(join(src, 'a.svg'));
            await eventually(() => expect(existsSync(join(out, 'drawable-mdpi', 'a.png'))).toBe(false));
            expect(DENSITY_DIRS.filter((d) => existsSync(join(out, d, 'a.png')))).toEqual([]);
            expect(existsSync(join(out, 'a.xml'))).toBe(false);
            await session.stop();
        });

        it('reports a conversion error and keeps watching', async () => {
            const session = watchSvgvd(src, '-o', out);
            writeFileSync(join(src, 'a.svg'), 'not svg');
            await eventually(() => expect(session.io.stderr).toContain(`✗ ${join(src, 'a.svg')}: Invalid SVG`));
            expect(read(join(out, 'a.xml'))).toBe(convert(ICON).xml); // the last good output stays
            writeFileSync(join(src, 'a.svg'), BLUE);
            await eventually(() => expect(read(join(out, 'a.xml'))).toBe(convert(BLUE).xml));
            expect(await session.stop()).toBe(0);
        });

        it('watches a single file to -o file.xml, also when an editor replaces it', async () => {
            const input = join(src, 'a.svg');
            const target = join(dir, 'icon.xml');
            const session = watchSvgvd(input, '-o', target);
            expect(read(target)).toBe(convert(ICON).xml);
            // Save through a temporary file renamed over the input, as many editors do.
            writeFileSync(join(src, 'a.svg.tmp'), BLUE);
            renameSync(join(src, 'a.svg.tmp'), input);
            await eventually(() => expect(read(target)).toBe(convert(BLUE).xml));
            writeFileSync(join(src, 'other.svg'), ICON);
            expect(existsSync(join(src, 'other.xml'))).toBe(false); // only the input file is watched
            await session.stop();
        });

        it('converts a file added in a new subdirectory with -r', async () => {
            const session = watchSvgvd(src, '-r', '-o', out);
            mkdirSync(join(src, 'sub'));
            writeFileSync(join(src, 'sub', 'c.svg'), BLUE);
            await eventually(() => expect(read(join(out, 'sub', 'c.xml'))).toBe(convert(BLUE).xml));
            await session.stop();
        });

        it('does not convert subdirectories without -r', async () => {
            const session = watchSvgvd(src, '-o', out);
            mkdirSync(join(src, 'sub'));
            writeFileSync(join(src, 'sub', 'c.svg'), BLUE);
            writeFileSync(join(src, 'b.svg'), BLUE); // a marker: once it is converted, sub/ was handled
            await eventually(() => expect(existsSync(join(out, 'b.xml'))).toBe(true));
            expect(readdirSync(out).sort()).toEqual(['a.xml', 'b.xml']);
            await session.stop();
        });

        it('refuses a resource name collision with --android-names until it is resolved', async () => {
            writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
            rmSync(join(src, 'a.svg'));
            const session = watchSvgvd(src, '-o', out, '--android-names');
            const target = join(out, 'arrow_left.xml');
            expect(read(target)).toBe(convert(ICON).xml);
            writeFileSync(join(src, 'arrow_left.svg'), BLUE);
            await eventually(() =>
                expect(session.io.stderr).toContain(
                    `✗ ${join(src, 'arrow_left.svg')}: Android resource name collision (not written): ${target} ← ${join(src, 'Arrow-Left.svg')}, ${join(src, 'arrow_left.svg')}`,
                ),
            );
            expect(read(target)).toBe(convert(ICON).xml);
            // The other file removed, the remaining one owns the name again.
            rmSync(join(src, 'Arrow-Left.svg'));
            await eventually(() => expect(read(target)).toBe(convert(BLUE).xml));
            await session.stop();
        });

        it('starts with a collision without writing it, as without --watch', async () => {
            writeFileSync(join(src, 'Arrow-Left.svg'), ICON);
            writeFileSync(join(src, 'arrow_left.svg'), BLUE);
            const session = watchSvgvd(src, '-o', out, '--android-names');
            expect(session.io.stderr).toContain('Android resource name collision (nothing written)');
            expect(existsSync(out)).toBe(false);
            rmSync(join(src, 'arrow_left.svg'));
            await eventually(() => expect(read(join(out, 'arrow_left.xml'))).toBe(convert(ICON).xml));
            await session.stop();
        });

        it('refuses a file whose output is taken by a file of the same name, without --android-names', async () => {
            const other = join(dir, 'other');
            mkdirSync(other);
            const session = watchSvgvd(src, other, '-o', out);
            writeFileSync(join(other, 'a.svg'), BLUE);
            await eventually(() =>
                expect(session.io.stderr).toContain(
                    `✗ ${join(other, 'a.svg')}: Output collision (not written): ${join(out, 'a.xml')} ← ${join(src, 'a.svg')}, ${join(other, 'a.svg')}`,
                ),
            );
            expect(read(join(out, 'a.xml'))).toBe(convert(ICON).xml);
            await session.stop();
        });

        it('deletes the output of an owner removed from a collision of three files or more', async () => {
            const others = ['d1', 'd2', 'd3'].map((name) => join(dir, name));
            for (const other of others) mkdirSync(other);
            const session = watchSvgvd(src, ...others, '-o', out);
            const target = join(out, 'a.xml');
            for (const other of others) {
                writeFileSync(join(other, 'a.svg'), BLUE);
                await eventually(() =>
                    expect(session.io.stderr).toContain(`✗ ${join(other, 'a.svg')}: Output collision (not written)`),
                );
            }
            expect(read(target)).toBe(convert(ICON).xml);
            // A refused file removed: the others still collide, the output of the owner stays.
            rmSync(join(others[2]!, 'a.svg'));
            // The owner removed: the two left still collide, so its output goes rather than stays stale.
            rmSync(join(src, 'a.svg'));
            await eventually(() => expect(existsSync(target)).toBe(false));
            expect(session.io.stderr).toContain(`✓ ${join(src, 'a.svg')} removed → ${target} deleted\n`);
            // One left: it owns the output.
            rmSync(join(others[0]!, 'a.svg'));
            await eventually(() => expect(read(target)).toBe(convert(BLUE).xml));
            expect(session.io.stderr.split(' deleted\n').length - 1).toBe(1);
            await session.stop();
        });

        it('calls a collision of Kotlin names a Kotlin name collision with --format compose', async () => {
            writeFileSync(join(src, 'ab.svg'), ICON); // Ab.kt
            const session = watchSvgvd(src, '-o', out, '--format', 'compose');
            expect(read(join(out, 'Ab.kt'))).toContain('val Ab: ImageVector');
            writeFileSync(join(src, 'a-b.svg'), BLUE); // AB.kt
            await eventually(() =>
                expect(session.io.stderr).toContain(
                    `✗ ${join(src, 'a-b.svg')}: Kotlin name collision (not written): ${join(out, 'Ab.kt')}, ${join(out, 'AB.kt')} ← ${join(src, 'ab.svg')}, ${join(src, 'a-b.svg')}`,
                ),
            );
            await session.stop();
        });

        it('starts with a Kotlin name collision without writing it, with --format compose', async () => {
            writeFileSync(join(src, 'ab.svg'), ICON);
            writeFileSync(join(src, 'a-b.svg'), BLUE);
            const session = watchSvgvd(src, '-o', out, '--format', 'compose');
            expect(session.io.stderr).toContain('✗ Kotlin name collision (nothing written)');
            expect(existsSync(out)).toBe(false);
            await session.stop();
        });

        describe('outputs differing only by case (one file on macOS and Windows)', () => {
            const owner = (): string => join(src, 'a.svg');
            const refused = (): string => join(src, 'A.svg');
            const conversions = (io: { stderr: string }): number => io.stderr.split(`✓ ${owner()} → `).length - 1;

            /** a.svg owns a.xml, A.svg (A.xml) is refused while both exist. */
            async function collide(...args: string[]) {
                const session = watchSvgvd(src, '-o', out, ...args);
                writeFileSync(refused(), BLUE);
                await eventually(() =>
                    expect(session.io.stderr).toContain(
                        `✗ ${refused()}: Output collision (not written): ${join(out, 'a.xml')}, ${join(out, 'A.xml')} ← ${owner()}, ${refused()}\n`,
                    ),
                );
                return session;
            }

            it('removing the refused file keeps the output of the other one', async () => {
                const session = await collide();
                expect(readdirSync(out)).toEqual(['a.xml']);
                rmSync(refused());
                // The owner is converted again rather than its output deleted (A.xml is a.xml there).
                await eventually(() => expect(conversions(session.io)).toBe(2));
                expect(session.io.stderr).not.toContain('deleted');
                expect(read(join(out, 'a.xml'))).toBe(convert(ICON).xml);
                await session.stop();
            });

            it('removing the owner deletes its output, then converts the refused file', async () => {
                const session = await collide();
                expect(readdirSync(out)).toEqual(['a.xml']);
                rmSync(owner());
                await eventually(() => expect(read(join(out, 'A.xml'))).toBe(convert(BLUE).xml));
                // Not a.xml left stale (Linux), nor A.svg's content under the name a.xml (macOS, Windows).
                expect(readdirSync(out)).toEqual(['A.xml']);
                const deleted = `✓ ${owner()} removed → ${join(out, 'a.xml')} deleted\n`;
                expect(session.io.stderr).toContain(deleted);
                // Deleted before A.xml is written: on a case-insensitive disk, the reverse deletes A.xml.
                expect(session.io.stderr.indexOf(deleted)).toBeLessThan(
                    session.io.stderr.lastIndexOf(`✓ ${refused()} → ${join(out, 'A.xml')}`),
                );
                await session.stop();
            });

            it('removing an owner rendered to PNG deletes its PNG fallback', async () => {
                writeFileSync(owner(), BLUR);
                const session = await collide('--strict', '--fallback-png', 'mdpi');
                expect(readdirSync(join(out, 'drawable-mdpi'))).toEqual(['a.png']);
                rmSync(owner());
                await eventually(() => expect(read(join(out, 'A.xml'))).toBe(convert(BLUE, { strict: true }).xml));
                expect(readdirSync(join(out, 'drawable-mdpi'))).toEqual([]);
                expect(session.io.stderr).toContain(
                    `✓ ${owner()} removed → ${join(out, 'drawable-mdpi', 'a.png')} deleted\n`,
                );
                await session.stop();
            });
        });

        it('converts a burst of writes once, after the last one', async () => {
            const session = watchSvgvd(src, '-o', out);
            const conversions = (): number => session.io.stderr.split(`✓ ${join(src, 'a.svg')} → `).length - 1;
            expect(conversions()).toBe(1);
            for (let i = 0; i < 5; i++) writeFileSync(join(src, 'a.svg'), i === 4 ? BLUE : ICON);
            await eventually(() => expect(read(join(out, 'a.xml'))).toBe(convert(BLUE).xml));
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(conversions()).toBe(2);
            await session.stop();
        });

        it.each([[[]], [['-r']]])(
            'reports a removed input directory (%j) and stops with exit code 1 once nothing is left',
            async (flags) => {
                const session = watchSvgvd(src, ...flags, '-o', out);
                rmSync(src, { recursive: true });
                await expect(session.done).resolves.toBe(1);
                expect(existsSync(join(out, 'a.xml'))).toBe(false);
                expect(session.io.stderr).toContain(`✗ ${src}: removed, no longer watched\n`);
                expect(session.io.stderr).toContain('Stopped watching: no input left to watch\n');
                expect(watched.watchers.every((w) => w.closed)).toBe(true);
            },
        );

        it('keeps watching the other inputs when one directory is removed', async () => {
            const other = join(dir, 'other');
            mkdirSync(other);
            const session = watchSvgvd(src, other, '-o', out);
            rmSync(src, { recursive: true });
            await eventually(() => expect(session.io.stderr).toContain(`✗ ${src}: removed, no longer watched\n`));
            // Created again, it is not watched any more: only the remaining input is.
            mkdirSync(src);
            writeFileSync(join(src, 'c.svg'), BLUE);
            writeFileSync(join(other, 'b.svg'), BLUE);
            await eventually(() => expect(read(join(out, 'b.xml'))).toBe(convert(BLUE).xml));
            expect(existsSync(join(out, 'c.xml'))).toBe(false);
            expect(await session.stop()).toBe(0);
        });

        it('reports a file input whose directory is removed', async () => {
            const session = watchSvgvd(join(src, 'a.svg'), '-o', out);
            rmSync(src, { recursive: true });
            await expect(session.done).resolves.toBe(1);
            expect(session.io.stderr).toContain(`✗ ${join(src, 'a.svg')}: removed, no longer watched\n`);
        });

        it('stops on SIGINT with exit code 0, closing its watchers', async () => {
            const listeners = process.listenerCount('SIGINT');
            const session = watchSvgvd(src, join(src, 'a.svg'), '-o', out);
            expect(watched.watchers).toHaveLength(2);
            expect(process.listenerCount('SIGINT')).toBe(listeners + 1);
            expect(await session.stop()).toBe(0);
            expect(session.io.stderr).toContain('Stopped watching');
            expect(process.listenerCount('SIGINT')).toBe(listeners);
            await eventually(() => expect(watched.watchers.every((w) => w.closed)).toBe(true));
        });

        it.each([
            [['-'], 'it cannot read stdin or -s'],
            [['-s', ICON], 'it cannot read stdin or -s'],
            [['SRC', '--stdout'], '--watch cannot be combined with --stdout'],
            [['SRC', '-o', 'OUT', '--json'], '--watch cannot be combined with --json'],
            [['SRC', '--dry-run'], '--watch cannot be combined with --dry-run'],
            [['SRC', '-o', 'OUT/icon.xml'], '--watch with -o <file.xml> needs a single existing input file'],
        ])('rejects %j with a usage error', (args, message) => {
            const argv = args.map((arg) => arg.replace('SRC', src).replace('OUT', out));
            const res = svgvdStdin(ICON, ['--watch', ...argv]);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain(message);
            expect(res.reads).toBe(0);
            expect(existsSync(out)).toBe(false);
            expect(watched.watchers).toHaveLength(0);
        });

        it('explains that -r needs a recursive fs.watch (Node.js 20+ on Linux), before converting', () => {
            watched.failure = Object.assign(new Error('The feature watch recursively is unavailable'), {
                code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
            });
            const res = svgvd('--watch', src, '-r', '-o', out);
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('--watch with -r needs Node.js 20 or later');
            expect(existsSync(out)).toBe(false);
        });

        it('documents the option in the help', () => {
            expect(svgvd('--help').stdout).toContain('-w, --watch');
        });
    });
});
