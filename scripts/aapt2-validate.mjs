#!/usr/bin/env node
// Compiles every fixture's converted VectorDrawable with Android's `aapt2`, then links the compiled
// resources against the newest `<sdk>/platforms/android-*/android.jar`, to prove the output is not
// just well-formed XML but a resource the Android toolchain actually accepts. `compile` alone only
// checks XML syntax; `link` resolves every `android:` attribute name and value against the platform.
//
// Locally without an SDK it prints a clear message and exits 0 (so it never blocks dev). In CI,
// once an SDK is present, an aapt2 failure or a conversion throw exits 1. A missing platform jar
// skips `link` locally (exit 0) but fails in CI (`process.env.CI`), where linking is the point.

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixturesDir = join(root, 'test', 'fixtures');

/** Finds the newest `aapt2` under <sdk>/build-tools/* of the given SDK root, or null. */
function findAapt2(sdkRoot) {
    if (!sdkRoot) return null;
    const buildToolsDir = join(sdkRoot, 'build-tools');
    let versions;
    try {
        versions = readdirSync(buildToolsDir).sort().reverse();
    } catch {
        return null;
    }
    for (const v of versions) {
        const candidate = join(buildToolsDir, v, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
        try {
            readFileSync(candidate); // existence + readability check
            return candidate;
        } catch {
            // try the next build-tools version
        }
    }
    return null;
}

/** Finds the newest `<sdk>/platforms/android-N/android.jar` (highest API level N), or null. */
function findAndroidJar(sdkRoot) {
    if (!sdkRoot) return null;
    const platformsDir = join(sdkRoot, 'platforms');
    let platforms;
    try {
        platforms = readdirSync(platformsDir);
    } catch {
        return null;
    }
    // Numeric sort on the API level: lexical order would put android-9 after android-36.
    const apiLevel = (name) => Number.parseInt(name.replace(/^android-/, ''), 10) || 0;
    platforms.sort((a, b) => apiLevel(b) - apiLevel(a));
    for (const p of platforms) {
        const candidate = join(platformsDir, p, 'android.jar');
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

// Gradients are emitted as `<aapt:attr name="android:fillColor">`, which VectorDrawable only
// supports from API 24 (Android 7.0) — the floor for every fixture.
const MIN_SDK = 24;

/** Runs aapt2 with the given args; on failure prints its output and returns false. */
function runAapt2(aapt2, step, args) {
    try {
        execFileSync(aapt2, args, { stdio: 'pipe' });
        return true;
    } catch (err) {
        const stderr = err && err.stderr ? err.stderr.toString() : '';
        const stdout = err && err.stdout ? err.stdout.toString() : '';
        console.error(`[aapt2-validate] ✗ aapt2 ${step} failed:`);
        if (stdout.trim()) console.error(stdout.trim());
        if (stderr.trim()) console.error(stderr.trim());
        if (!stdout.trim() && !stderr.trim()) console.error(`  ${err instanceof Error ? err.message : err}`);
        return false;
    }
}

async function main() {
    const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
    const aapt2 = findAapt2(sdkRoot);

    if (!aapt2) {
        console.log(
            '[aapt2-validate] No Android SDK found (set ANDROID_SDK_ROOT or ANDROID_HOME to a SDK with build-tools).',
        );
        console.log('[aapt2-validate] Skipping aapt2 compilation. (This is expected on machines without the SDK.)');
        process.exit(0);
    }
    console.log(`[aapt2-validate] Using aapt2: ${aapt2}`);

    // dist/index.js is the compiled library entrypoint; build before running this script.
    const distEntry = join(root, 'dist', 'index.js');
    let convert;
    try {
        ({ convert } = await import(pathToFileUrl(distEntry)));
    } catch (err) {
        console.error(`[aapt2-validate] Could not import ${distEntry}. Did you run \`npm run build\`?`);
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    const fixtures = readdirSync(fixturesDir)
        .filter((f) => f.endsWith('.svg'))
        .sort();
    if (fixtures.length === 0) {
        console.error('[aapt2-validate] No SVG fixtures found.');
        process.exit(1);
    }

    const workDir = mkdtempSync(join(tmpdir(), 'aapt2-validate-'));
    const resDir = join(workDir, 'res', 'drawable');
    mkdirSync(resDir, { recursive: true });

    // Map each fixture to a valid Android resource filename (dN.xml — lowercase, starts with a letter).
    const mapping = [];
    let convertFailures = 0;
    fixtures.forEach((file, i) => {
        const name = `d${i}`;
        try {
            const svg = readFileSync(join(fixturesDir, file), 'utf8');
            const { xml } = convert(svg, { optimize: true });
            writeFileSync(join(resDir, `${name}.xml`), xml);
            mapping.push({ file, name });
        } catch (err) {
            convertFailures++;
            console.error(
                `[aapt2-validate] ✗ conversion failed for ${file}: ${err instanceof Error ? err.message : err}`,
            );
        }
    });

    if (convertFailures > 0) {
        cleanup(workDir);
        console.error(`[aapt2-validate] ${convertFailures} conversion(s) failed.`);
        process.exit(1);
    }

    const outZip = join(workDir, 'out.zip');
    if (!runAapt2(aapt2, 'compile', ['compile', '--dir', join(workDir, 'res'), '-o', outZip])) {
        cleanup(workDir);
        process.exit(1);
    }
    console.log(`[aapt2-validate] ✓ aapt2 compiled all ${mapping.length} fixtures with no errors.`);

    const androidJar = findAndroidJar(sdkRoot);
    let linked = false;
    if (!androidJar) {
        console.log(
            `[aapt2-validate] No platform android.jar found under ${join(sdkRoot, 'platforms')} ` +
                '(install one, e.g. `sdkmanager "platforms;android-36"`).',
        );
        if (process.env.CI) {
            cleanup(workDir);
            console.error('[aapt2-validate] ✗ CI requires `aapt2 link`; failing.');
            process.exit(1);
        }
        console.log('[aapt2-validate] Skipping aapt2 link. (Expected on machines without an SDK platform.)');
    } else {
        console.log(`[aapt2-validate] Linking against: ${androidJar}`);
        const manifest = join(workDir, 'AndroidManifest.xml');
        writeFileSync(
            manifest,
            '<?xml version="1.0" encoding="utf-8"?>\n' +
                '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.svgvd.validate">\n' +
                `    <uses-sdk android:minSdkVersion="${MIN_SDK}" />\n` +
                '</manifest>\n',
        );
        const linkArgs = [
            'link',
            '-I',
            androidJar,
            '--manifest',
            manifest,
            '--min-sdk-version',
            String(MIN_SDK),
            '--auto-add-overlay',
            '-o',
            join(workDir, 'out.apk'),
            outZip,
        ];
        if (!runAapt2(aapt2, 'link', linkArgs)) {
            cleanup(workDir);
            process.exit(1);
        }
        linked = true;
        console.log(`[aapt2-validate] ✓ aapt2 linked all ${mapping.length} fixtures with no errors.`);
    }

    cleanup(workDir);
    console.log(`[aapt2-validate] ✓ ${linked ? 'compile + link' : 'compile only'} OK:`);
    for (const { file, name } of mapping) console.log(`    ${name}.xml  ←  ${file}`);
    process.exit(0);
}

function cleanup(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // best-effort temp cleanup
    }
}

// Cross-platform file:// URL for dynamic import of an absolute path.
function pathToFileUrl(p) {
    const resolved = p.replace(/\\/g, '/');
    return new URL(`file://${resolved.startsWith('/') ? '' : '/'}${resolved}`).href;
}

main().catch((err) => {
    console.error(`[aapt2-validate] Unexpected error: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
});
