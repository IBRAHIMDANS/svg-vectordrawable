#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from './convert.js';
import { assertDistinctOutputs, defaultOutputPath, type FileNamingOptions } from './file.js';
import { WARNING_CODES, type ConvertOptions, type Severity, type WarningCode } from './types.js';

const HELP = `svgvd — convert SVG to Android VectorDrawable

Usage:
  svgvd <input.svg|dir> [options]

Options:
  -s, --string <svg>   Convert an inline SVG string (prints to stdout)
  -o, --out <path>     Output file (single input) or directory (batch)
  --stdout             Print result to stdout instead of writing a file
  --no-optimize        Skip svgo normalization (not recommended)
  --strict             Fail on the first lossy or approximated construct
  --strict=lossy       Fail only when content is lost (approximations stay warnings)
  --rule <code=level>  Per-warning severity: off | warn | error (repeatable),
                       e.g. --strict --rule opacity-approximated=warn
  --min-sdk <n>        Warn when the output needs a higher Android API level
                       (gradients and fillType need API 24)
  --xml-tag            Prepend an XML declaration
  --tint <color>       Add android:tint to the <vector>
  --android-names      Name outputs as valid Android resources (Arrow-Left.svg →
                       arrow_left.xml); fails if two inputs map to the same name.
                       An explicit -o file.xml is used as is
  -p, --precision <n>  Decimal places for numbers (default 3)
  -h, --help           Show this help
`;

const SEVERITIES = new Set(['off', 'warn', 'error']);

/** Output sinks, injectable so the CLI can be exercised in-process. */
export interface CliIo {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

const processIo: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
};

/** Thrown during argument parsing to stop early with an exit code. */
class CliExit {
    constructor(readonly code: number) {}
}

function parseArgs(
    argv: string[],
    io: CliIo,
): {
    inputs: string[];
    inline?: string;
    out?: string;
    stdout: boolean;
    opts: ConvertOptions;
    naming: FileNamingOptions;
} {
    const inputs: string[] = [];
    const opts: ConvertOptions = {};
    const naming: FileNamingOptions = {};
    let out: string | undefined;
    let inline: string | undefined;
    let stdout = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '-h' || arg === '--help') {
            io.stdout(HELP);
            throw new CliExit(0);
        } else if (arg === '-s' || arg === '--string') inline = argv[++i];
        else if (arg === '-o' || arg === '--out') out = argv[++i];
        else if (arg === '--stdout') stdout = true;
        else if (arg === '--no-optimize') opts.optimize = false;
        else if (arg === '--strict') opts.strict = true;
        else if (arg === '--strict=lossy') opts.strict = 'lossy';
        else if (arg === '--min-sdk') {
            const value = argv[++i] ?? '';
            if (!/^[1-9]\d*$/.test(value)) {
                io.stderr(`Invalid --min-sdk (expected a positive integer): ${value}\n`);
                throw new CliExit(1);
            }
            opts.minSdk = Number(value);
        } else if (arg === '--rule') {
            const [code, level] = (argv[++i] ?? '').split('=');
            if (!(WARNING_CODES as readonly string[]).includes(code ?? '') || !SEVERITIES.has(level ?? '')) {
                io.stderr(
                    `Invalid --rule (expected <code>=off|warn|error): ${argv[i]}\nKnown codes: ${WARNING_CODES.join(', ')}\n`,
                );
                throw new CliExit(1);
            }
            opts.rules = { ...opts.rules, [code as WarningCode]: level as Severity };
        } else if (arg === '--xml-tag') opts.xmlTag = true;
        else if (arg === '--android-names') naming.androidNames = true;
        else if (arg === '--tint') opts.tint = argv[++i];
        else if (arg === '-p' || arg === '--precision') opts.floatPrecision = Number(argv[++i]);
        else if (arg.startsWith('-') && arg !== '-') {
            io.stderr(`Unknown option: ${arg}\n`);
            throw new CliExit(1);
        } else inputs.push(arg);
    }
    return { inputs, inline, out, stdout, opts, naming };
}

function listSvgs(path: string): string[] {
    if (statSync(path).isDirectory())
        return readdirSync(path)
            .filter((f) => extname(f).toLowerCase() === '.svg')
            .map((f) => join(path, f));
    return [path];
}

/** Writes `content` to `target`, creating its parent directories first. */
function writeOutput(target: string, content: string): void {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

/** Runs the CLI against `argv` (without the node/script prefix) and returns the exit code. */
export function run(argv: string[], io: CliIo = processIo): number {
    let args: ReturnType<typeof parseArgs>;
    try {
        args = parseArgs(argv, io);
    } catch (err) {
        if (err instanceof CliExit) return err.code;
        throw err;
    }
    const { inputs, inline, out, stdout, opts, naming } = args;

    if (inline !== undefined) {
        const { xml, warnings } = convert(inline, opts);
        for (const w of warnings) io.stderr(`  ⚠ [${w.code}] ${w.message}\n`);
        if (out && extname(out) === '.xml') writeOutput(out, xml);
        else io.stdout(xml);
        return 0;
    }

    if (inputs.length === 0) {
        io.stderr(HELP);
        return 1;
    }

    const files = inputs.flatMap(listSvgs);
    const explicitTarget = out && files.length === 1 && extname(out) === '.xml' ? out : undefined;
    const jobs = files.map((input) => ({ input, output: explicitTarget ?? defaultOutputPath(input, out, naming) }));
    if (!stdout) {
        try {
            assertDistinctOutputs(jobs, naming);
        } catch (err) {
            io.stderr(`✗ ${(err as Error).message}\n`);
            return 1;
        }
    }
    let failures = 0;
    for (const { input: file, output: target } of jobs) {
        try {
            const { xml, warnings } = convert(readFileSync(file, 'utf8'), opts);
            for (const w of warnings) io.stderr(`  ⚠ ${basename(file)}: [${w.code}] ${w.message}\n`);
            if (stdout) {
                io.stdout(xml);
            } else {
                writeOutput(target, xml);
                io.stderr(`✓ ${file} → ${target}\n`);
            }
        } catch (err) {
            failures++;
            io.stderr(`✗ ${file}: ${(err as Error).message}\n`);
        }
    }
    return failures ? 1 : 0;
}

/** True when this module is the process entry point (also through an npm bin symlink). */
function isMain(): boolean {
    try {
        return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isMain()) process.exitCode = run(process.argv.slice(2));
