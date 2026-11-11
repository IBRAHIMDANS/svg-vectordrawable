// Runs with `node --test` (see package.json). Not named *.test.mjs so the repository's root vitest
// does not collect it: it needs this folder's own node_modules (vite).
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, createLogger, createServer } from 'vite';
import svgVectorDrawable from '../dist/index.js';

const exampleIcons = fileURLToPath(new URL('../example/icons', import.meta.url));
const OVERLAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g opacity=".5">
<rect width="10" height="10"/><rect x="5" width="10" height="10"/></g></svg>`;

const dirs = [];
let root;

/** A fresh project: index.html + icons/ (copied from the example). */
function project() {
    const dir = mkdtempSync(join(tmpdir(), 'vite-plugin-svgvd-'));
    dirs.push(dir);
    cpSync(exampleIcons, join(dir, 'icons'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    return dir;
}

/** A Vite logger that records every message. */
function recordingLogger() {
    const base = createLogger('silent');
    const logs = { info: [], warn: [], error: [] };
    for (const level of ['info', 'warn', 'error']) {
        base[level] = (msg) => {
            logs[level].push(msg);
        };
    }
    base.warnOnce = base.warn;
    return { logger: base, logs };
}

const summaries = (logs) => logs.info.filter((m) => m.startsWith('svg-vectordrawable:'));

function config(dir, options = {}, logger = recordingLogger().logger) {
    return {
        root: dir,
        configFile: false,
        logLevel: 'info',
        customLogger: logger,
        build: { outDir: join(dir, 'dist'), emptyOutDir: true },
        plugins: [svgVectorDrawable({ input: 'icons', output: 'res/drawable', ...options })],
    };
}

async function run(dir, options) {
    const { logger, logs } = recordingLogger();
    await build(config(dir, options, logger));
    return logs;
}

const out = (file) => join(root, 'res/drawable', file);

beforeEach(() => {
    root = project();
});

after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('build', () => {
    test('converts every SVG with Android resource names', async () => {
        const logs = await run(root);
        assert.match(summaries(logs)[0], /3 converted, 0 up to date, 0 removed/);
        for (const file of ['arrow_left.xml', 'check.xml', 'star.xml']) {
            assert.match(readFileSync(out(file), 'utf8'), /^<vector /);
        }
    });

    test('a second build with nothing changed converts 0 files and rewrites nothing', async () => {
        await run(root);
        const before = statSync(out('star.xml')).mtimeMs;
        const logs = await run(root);
        assert.match(summaries(logs)[0], /0 converted, 3 up to date, 0 removed/);
        assert.equal(statSync(out('star.xml')).mtimeMs, before);
    });

    test('only the changed file is converted again', async () => {
        await run(root);
        writeFileSync(join(root, 'icons/star.svg'), OVERLAP);
        const logs = await run(root);
        assert.match(summaries(logs)[0], /1 converted, 2 up to date, 0 removed/);
    });

    test('changing an option converts everything again', async () => {
        await run(root);
        const logs = await run(root, { tint: '#FF0000' });
        assert.match(summaries(logs)[0], /3 converted, 0 up to date/);
        assert.match(readFileSync(out('check.xml'), 'utf8'), /android:tint="#FF0000"/);
    });

    test('an output whose source is gone is deleted, hand-written files are kept', async () => {
        await run(root);
        writeFileSync(out('hand_written.xml'), '<vector/>');
        unlinkSync(join(root, 'icons/Arrow-Left.svg'));
        const logs = await run(root);
        assert.match(summaries(logs)[0], /0 converted, 2 up to date, 1 removed/);
        assert.equal(existsSync(out('arrow_left.xml')), false);
        assert.equal(existsSync(out('hand_written.xml')), true);
    });

    test('a deleted output is regenerated', async () => {
        await run(root);
        unlinkSync(out('check.xml'));
        const logs = await run(root);
        assert.match(summaries(logs)[0], /1 converted, 2 up to date/);
        assert.equal(existsSync(out('check.xml')), true);
    });

    test('androidNames: false keeps the file names', async () => {
        await run(root, { androidNames: false });
        assert.equal(existsSync(out('Arrow-Left.xml')), true);
    });
});

describe('warnings and errors', () => {
    test('warnings go through the Vite logger and do not fail the build', async () => {
        writeFileSync(join(root, 'icons/overlap.svg'), OVERLAP);
        const logs = await run(root);
        assert.ok(
            logs.warn.some((m) => m.includes('overlap.svg: [opacity-approximated]')),
            logs.warn.join('\n'),
        );
        assert.equal(existsSync(out('overlap.xml')), true);
    });

    test('strict errors fail the build, after converting the other files', async () => {
        writeFileSync(join(root, 'icons/overlap.svg'), OVERLAP);
        await assert.rejects(
            build(config(root, { strict: true })),
            /1 file\(s\) failed:\s+overlap\.svg: \[opacity-approximated\]/,
        );
        assert.equal(existsSync(out('star.xml')), true);
        assert.equal(existsSync(out('overlap.xml')), false);
    });

    test('a failed file is retried on the next build', async () => {
        writeFileSync(join(root, 'icons/overlap.svg'), OVERLAP);
        await assert.rejects(build(config(root, { strict: true })));
        await assert.rejects(build(config(root, { strict: true })), /overlap\.svg/);
    });

    test('two sources mapping to the same resource name fail before writing', async () => {
        cpSync(join(root, 'icons/star.svg'), join(root, 'icons/Star.svg'));
        await assert.rejects(build(config(root)), /both map to star\.xml/);
        assert.equal(existsSync(out('check.xml')), false);
    });

    test('a missing input folder fails the build', async () => {
        rmSync(join(root, 'icons'), { recursive: true });
        await assert.rejects(build(config(root)), /input folder not found/);
    });
});

/** Waits until `predicate` holds: file watchers and rebuilds are asynchronous. */
async function until(predicate, what, timeout = 10_000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}
const settle = () => new Promise((r) => setTimeout(r, 500));
const counts = (messages) => messages.map((m) => m.split(' (')[0]);

describe('watch mode (vite build --watch)', () => {
    test('re-converts only the changed file and deletes the output of a removed source', async () => {
        const { logger, logs } = recordingLogger();
        const base = config(root, {}, logger);
        const watcher = await build({ ...base, build: { ...base.build, watch: {} } });
        let ends = 0;
        watcher.on('event', (event) => {
            if (event.code === 'END') ends++;
        });
        try {
            await until(() => ends === 1, 'the first build');
            assert.deepEqual(counts(summaries(logs)), ['svg-vectordrawable: 3 converted, 0 up to date, 0 removed']);
            await settle(); // let the file watcher start

            writeFileSync(join(root, 'icons/star.svg'), OVERLAP);
            await until(() => ends === 2, 'the rebuild after a change');
            // watchChange converts star.svg alone; the rebuild that follows finds everything up to date.
            assert.deepEqual(counts(summaries(logs).slice(1)), [
                'svg-vectordrawable: 1 converted, 0 up to date, 0 removed',
                'svg-vectordrawable: 0 converted, 3 up to date, 0 removed',
            ]);
            assert.ok(logs.warn.some((m) => m.includes('star.svg: [opacity-approximated]')));
            await settle();

            unlinkSync(join(root, 'icons/check.svg'));
            await until(() => ends === 3, 'the rebuild after a deletion');
            assert.equal(existsSync(out('check.xml')), false);
            assert.equal(existsSync(out('arrow_left.xml')), true);
            assert.match(summaries(logs)[3], /0 converted, 0 up to date, 1 removed/);
        } finally {
            await watcher.close();
        }
    });
});

describe('dev server (vite)', () => {
    test('converts at startup, then on change; a strict error is logged without stopping the server', async () => {
        const { logger, logs } = recordingLogger();
        const server = await createServer({
            ...config(root, { strict: true }, logger),
            server: { port: 0, ws: false },
        });
        try {
            await server.listen();
            await until(() => summaries(logs).length === 1, 'the startup pass');
            assert.deepEqual(counts(summaries(logs)), ['svg-vectordrawable: 3 converted, 0 up to date, 0 removed']);
            await settle();

            writeFileSync(join(root, 'icons/check.svg'), readFileSync(join(root, 'icons/Arrow-Left.svg')));
            await until(() => summaries(logs).length === 2, 'the change');
            assert.deepEqual(counts(summaries(logs).slice(1)), [
                'svg-vectordrawable: 1 converted, 0 up to date, 0 removed',
            ]);

            writeFileSync(join(root, 'icons/overlap.svg'), OVERLAP);
            await until(() => logs.error.length === 1, 'the strict error');
            assert.match(logs.error[0], /overlap\.svg: \[opacity-approximated\]/);

            unlinkSync(join(root, 'icons/star.svg'));
            await until(() => !existsSync(out('star.xml')), 'the deletion');
        } finally {
            await server.close();
        }
    });
});
