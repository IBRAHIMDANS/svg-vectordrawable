#!/usr/bin/env node
// Converts a corpus of real-world icon sets (Feather, Bootstrap Icons, Heroicons, Tabler) through the
// BUILT library (`dist/index.js`), with `optimize` both on and off, and fails on any exception or on
// any warning whose code is not explicitly allowed below.
//
// The icon packages are installed into a cache directory OUTSIDE the project (never in package.json):
// `${os.tmpdir()}/svgvd-corpus` by default, overridable with SVGVD_CORPUS_DIR. They are installed only
// when missing, so subsequent runs are offline. Run `npm run build` first.

import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Warning codes tolerated on this corpus. Currently none: the corpus converts warning-free. */
const ALLOWED_WARNINGS = new Set([]);

/**
 * npm packages to install, pinned so a new icon release can never break CI without a code change
 * (bump deliberately), and the SVG directories (relative to node_modules) to convert.
 */
const PACKAGES = {
    'feather-icons': '4.29.2',
    'bootstrap-icons': '1.13.1',
    heroicons: '2.2.0',
    '@tabler/icons': '3.49.0',
};
const SETS = [
    { pkg: 'feather-icons', dir: 'feather-icons/dist/icons' },
    { pkg: 'bootstrap-icons', dir: 'bootstrap-icons/icons' },
    { pkg: 'heroicons', dir: 'heroicons/24/outline' },
    { pkg: 'heroicons', dir: 'heroicons/24/solid' },
    { pkg: '@tabler/icons', dir: '@tabler/icons/icons/outline' },
    { pkg: '@tabler/icons', dir: '@tabler/icons/icons/filled' },
];

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cacheDir = process.env.SVGVD_CORPUS_DIR || join(tmpdir(), 'svgvd-corpus');
const modulesDir = join(cacheDir, 'node_modules');

/** Installs the icon packages into the cache unless they are all already there. */
function ensureCorpus() {
    const installedVersion = (p) => {
        const manifest = join(modulesDir, p, 'package.json');
        return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : undefined;
    };
    const missing = Object.entries(PACKAGES)
        .filter(([p, version]) => installedVersion(p) !== version)
        .map(([p, version]) => `${p}@${version}`);
    if (missing.length === 0) {
        console.log(`[corpus] Using cached corpus: ${cacheDir}`);
        return;
    }
    console.log(`[corpus] Installing ${missing.join(', ')} into ${cacheDir} …`);
    mkdirSync(cacheDir, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['install', '--prefix', cacheDir, '--no-save', '--no-audit', '--no-fund', ...missing], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
}

function formatError(err) {
    return err instanceof Error ? err.message : String(err);
}

async function main() {
    const distEntry = join(root, 'dist', 'index.js');
    let convert;
    try {
        ({ convert } = await import(pathToFileURL(distEntry).href));
    } catch (err) {
        console.error(`[corpus] Could not import ${distEntry}. Did you run \`npm run build\`?`);
        console.error(`  ${formatError(err)}`);
        process.exit(1);
    }

    ensureCorpus();

    const started = Date.now();
    let totalFiles = 0;
    let totalConversions = 0;
    const exceptions = []; // { file, optimize, message }
    const warningsByCode = new Map(); // code -> count
    const disallowed = []; // { file, optimize, code, message }
    const perSet = [];

    for (const { pkg, dir } of SETS) {
        const abs = join(modulesDir, dir);
        let files;
        try {
            files = readdirSync(abs)
                .filter((f) => f.endsWith('.svg'))
                .sort();
        } catch (err) {
            console.error(`[corpus] ✗ Missing icon directory ${abs} (${pkg} layout changed?): ${formatError(err)}`);
            process.exit(1);
        }
        if (files.length === 0) {
            console.error(`[corpus] ✗ No SVG found in ${abs} (${pkg} layout changed?).`);
            process.exit(1);
        }

        const stats = { dir, files: files.length, exceptions: 0, warnings: 0 };
        for (const f of files) {
            const svg = readFileSync(join(abs, f), 'utf8');
            const rel = `${dir}/${f}`;
            for (const optimize of [true, false]) {
                totalConversions++;
                let result;
                try {
                    result = convert(svg, { optimize });
                } catch (err) {
                    stats.exceptions++;
                    exceptions.push({ file: rel, optimize, message: formatError(err) });
                    continue;
                }
                for (const w of result.warnings) {
                    stats.warnings++;
                    warningsByCode.set(w.code, (warningsByCode.get(w.code) ?? 0) + 1);
                    if (!ALLOWED_WARNINGS.has(w.code)) {
                        disallowed.push({ file: rel, optimize, code: w.code, message: w.message });
                    }
                }
            }
        }
        totalFiles += files.length;
        perSet.push(stats);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[corpus] ${totalFiles} files, ${totalConversions} conversions (optimize true + false) in ${seconds}s`);
    console.log('[corpus] Per icon set:');
    for (const s of perSet) {
        console.log(
            `    ${s.dir.padEnd(30)} ${String(s.files).padStart(5)} files  ` +
                `${String(s.exceptions).padStart(4)} exceptions  ${String(s.warnings).padStart(4)} warnings`,
        );
    }
    console.log(`[corpus] Exceptions: ${exceptions.length}`);
    console.log(`[corpus] Warnings by code:${warningsByCode.size === 0 ? ' none' : ''}`);
    for (const [code, count] of [...warningsByCode].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${code}: ${count}${ALLOWED_WARNINGS.has(code) ? ' (allowed)' : ''}`);
    }

    // Show a bounded sample so a regression is diagnosable without flooding the CI log.
    const SAMPLE = 20;
    for (const e of exceptions.slice(0, SAMPLE)) {
        console.error(`    ✗ throw  ${e.file} (optimize=${e.optimize}): ${e.message}`);
    }
    for (const d of disallowed.slice(0, SAMPLE)) {
        console.error(`    ✗ ${d.code}  ${d.file} (optimize=${d.optimize}): ${d.message}`);
    }

    if (exceptions.length > 0 || disallowed.length > 0) {
        console.error(`[corpus] ✗ ${exceptions.length} exception(s), ${disallowed.length} disallowed warning(s).`);
        process.exit(1);
    }
    console.log('[corpus] ✓ No exception and no disallowed warning.');
}

main().catch((err) => {
    console.error(`[corpus] Unexpected error: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
});
