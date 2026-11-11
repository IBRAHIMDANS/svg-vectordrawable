#!/usr/bin/env node
// Post-build fix for the bundled declaration files (run by `pnpm run build`, after tsup).
//
// svgo is ESM-only and its `types` condition serves an ESM declaration file to `require` too, so a
// CommonJS consumer (`moduleResolution: node16`, `skipLibCheck: false`) gets TS1479 on the plain
// `import { Config } from 'svgo'` of dist/index.d.cts. The fix is a type-only import with
// `resolution-mode: import`, but tsup's declaration bundler (rollup-plugin-dts) drops import
// attributes and the `type` modifier, so it cannot be written in src/: it is restored here.
//
// Idempotent. Fails (exit 1) when a declaration file references 'svgo' in a form it does not know,
// so that a tsup upgrade changing the emitted shape cannot silently undo the fix.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// A named import from 'svgo', plain or already fixed: `import [type] { A[, B as C] } from 'svgo'[ with {…}];`
const KNOWN_IMPORT =
    /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])svgo\2(?:\s+with\s*\{\s*['"]resolution-mode['"]\s*:\s*['"]import['"]\s*\})?\s*;?[ \t]*$/gm;
// Any other reference to the 'svgo' module (other import shapes, re-exports, import() types).
const ANY_SVGO_REFERENCE = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])svgo(?:\/[^'"]*)?\1/m;

const fixedImport = (names) => {
    // `import type { … }` forbids inline `type` modifiers on its specifiers.
    const specifiers = names
        .split(',')
        .map((s) => s.trim().replace(/^type\s+/, ''))
        .filter(Boolean)
        .join(', ');
    return `import type { ${specifiers} } from 'svgo' with { 'resolution-mode': 'import' };`;
};

let files;
try {
    files = readdirSync(DIST).filter((f) => /\.d\.c?ts$/.test(f));
} catch (err) {
    console.error(`fix-dts-svgo: cannot read ${DIST} (${err.message}); run tsup first.`);
    process.exit(1);
}
if (files.length === 0) {
    console.error(`fix-dts-svgo: no declaration files in ${DIST}; run tsup first.`);
    process.exit(1);
}

const failures = [];
for (const file of files) {
    const path = join(DIST, file);
    const source = readFileSync(path, 'utf8');
    const fixed = source.replace(KNOWN_IMPORT, (_, names) => fixedImport(names));
    const leftover = fixed.replace(KNOWN_IMPORT, '').match(ANY_SVGO_REFERENCE);
    if (leftover) {
        const line = fixed.slice(0, leftover.index).split('\n').length;
        failures.push(`${file}:${line}: unsupported 'svgo' reference: ${leftover[0].trim()}`);
        continue;
    }
    if (fixed !== source) {
        writeFileSync(path, fixed);
        console.log(`fix-dts-svgo: ${file}: svgo import made type-only with resolution-mode "import"`);
    }
}

if (failures.length > 0) {
    console.error(
        'fix-dts-svgo: the declaration bundler emitted a svgo import this script cannot rewrite\n' +
            '(CommonJS consumers would get TS1479). Update scripts/fix-dts-svgo.mjs:\n  ' +
            failures.join('\n  '),
    );
    process.exit(1);
}
