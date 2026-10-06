import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { convert } from './convert.js';
import { androidResourceName, assertNoNameCollisions } from './resourceName.js';
import type { ConvertOptions, ConvertResult, Warning } from './types.js';

/** How default output file names are derived from input file names. */
export interface FileNamingOptions {
    /**
     * Rewrite default output names into valid Android resource names (`Arrow-Left.svg` → `arrow_left.xml`).
     * An explicit output path is always used verbatim. Default `false`.
     */
    androidNames?: boolean;
}

/** Default output path for `inputPath`: `<outputDir>/<name>.xml`, `outputDir` defaulting to the input's directory. */
export function defaultOutputPath(inputPath: string, outputDir?: string, naming?: FileNamingOptions): string {
    const name = basename(inputPath, extname(inputPath));
    return join(outputDir ?? dirname(inputPath), `${naming?.androidNames ? androidResourceName(name) : name}.xml`);
}

/**
 * Fails when several inputs would be written to the same output path, before anything is written.
 * Only checked with `androidNames`, where distinct source names can collapse to the same resource name.
 */
export function assertDistinctOutputs(
    entries: readonly { input: string; output: string }[],
    naming?: FileNamingOptions,
): void {
    if (naming?.androidNames) assertNoNameCollisions(entries.map(({ input, output }) => ({ input, name: output })));
}

/**
 * Converts a single SVG file to a VectorDrawable XML file.
 * Defaults the output path to the input with a `.xml` extension. (Node only.)
 */
export function convertFile(
    inputPath: string,
    outputPath?: string,
    options?: ConvertOptions,
    naming?: FileNamingOptions,
): ConvertResult {
    const result = convert(readFileSync(inputPath, 'utf8'), options);
    const target = outputPath ?? defaultOutputPath(inputPath, undefined, naming);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result.xml);
    return result;
}

export interface ConvertDirResult {
    input: string;
    output: string;
    warnings: Warning[];
}

/**
 * Converts every `*.svg` in a directory to `*.xml` in `outputDir`. (Node only, non-recursive.)
 * With `naming.androidNames`, throws before writing anything if two inputs map to the same resource name.
 */
export function convertDir(
    inputDir: string,
    outputDir: string,
    options?: ConvertOptions,
    naming?: FileNamingOptions,
): ConvertDirResult[] {
    const jobs = readdirSync(inputDir)
        .map((entry) => join(inputDir, entry))
        .filter((p) => statSync(p).isFile() && extname(p).toLowerCase() === '.svg')
        .map((input) => ({ input, output: defaultOutputPath(input, outputDir, naming) }));
    assertDistinctOutputs(jobs, naming);
    mkdirSync(outputDir, { recursive: true });
    return jobs.map(({ input, output }) => ({ input, output, warnings: convertFile(input, output, options).warnings }));
}
