// Smoke test of the playground against the current build: `pnpm build && node --test playground/smoke-test.mjs`.
// worker.js runs in a real thread (worker_threads + a tiny shim for importScripts / postMessage), driven
// by core.js exactly as the page does. Named *-test.mjs, not *.test.mjs, so vitest does not collect it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildOptions, createConverter, describeError, describeUnresolvedColors, svgDataUrl } from './core.js';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const BUNDLE = here('../dist/browser-lite.global.js');
const WORKER = here('./worker.js');
const fixture = (name) => readFileSync(here(`../test/fixtures/${name}`), 'utf8');

// Runs worker.js as a classic Web Worker would: `importScripts('browser-lite.global.js')` must resolve
// to a file next to the page, which the Pages workflow provides; here it maps to dist/.
const SHIM = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
globalThis.self = globalThis;
globalThis.importScripts = (...urls) => {
    for (const url of urls) {
        if (url !== 'browser-lite.global.js') throw new Error('unexpected importScripts(' + url + ')');
        vm.runInThisContext(readFileSync(workerData.bundle, 'utf8'), { filename: url });
    }
};
globalThis.postMessage = (data) => parentPort.postMessage(data);
vm.runInThisContext(readFileSync(workerData.worker, 'utf8'), { filename: 'worker.js' });
parentPort.on('message', (data) => self.onmessage({ data }));
`;

/** Wraps a worker_threads Worker in the Web Worker surface core.js uses. */
function asWebWorker(thread) {
    const worker = {
        onmessage: null,
        onerror: null,
        terminated: false,
        postMessage: (data) => thread.postMessage(data),
        terminate: () => {
            worker.terminated = true;
            thread.terminate();
        },
    };
    thread.on('message', (data) => worker.onmessage?.({ data }));
    thread.on('error', (error) => worker.onerror?.({ message: error.message }));
    return worker;
}

const spawnPlaygroundWorker = () =>
    asWebWorker(new Worker(SHIM, { eval: true, workerData: { bundle: BUNDLE, worker: WORKER } }));
// Stands in for an input slow enough to hit the timeout.
const spawnHangingWorker = () =>
    asWebWorker(
        new Worker("require('node:worker_threads').parentPort.on('message', () => { for (;;); });", { eval: true }),
    );

/** A converter whose workers are recorded, so that tests can check termination and respawn. */
function trackedConverter(factories, config) {
    const spawned = [];
    const converter = createConverter(() => {
        const factory = factories[Math.min(spawned.length, factories.length - 1)];
        const worker = factory();
        spawned.push(worker);
        return worker;
    }, config);
    return { converter, spawned };
}

test('the current build provides the IIFE the worker loads, with the global svgvd', () => {
    assert.ok(existsSync(BUNDLE), 'dist/browser-lite.global.js is missing: run `pnpm build` first');
    const source = readFileSync(BUNDLE, 'utf8');
    assert.match(source, /\bvar svgvd=/);
    assert.match(readFileSync(WORKER, 'utf8'), /importScripts\('browser-lite\.global\.js'\)/);
});

test('a gradient fixture produces XML and a preview', async (t) => {
    const { converter } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const outcome = await converter.convert(fixture('linear-gradient.svg'), buildOptions());
    assert.equal(outcome.status, 'ok', outcome.message);
    assert.match(outcome.xml, /^<vector /);
    assert.match(outcome.xml, /<aapt:attr name="android:fillColor">\s*<gradient/);
    assert.deepEqual(outcome.warnings, []);
    assert.equal(outcome.minSdk, 24);
    assert.match(outcome.preview, /^<svg[^>]*>/);
    assert.match(outcome.preview, /<linearGradient/);
    const url = svgDataUrl(outcome.preview);
    assert.ok(url.startsWith('data:image/svg+xml,%3Csvg'));
    assert.equal(decodeURIComponent(url.slice('data:image/svg+xml,'.length)), outcome.preview);
});

test('an SVG with <text> reports unsupported-element with its category', async (t) => {
    const { converter } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>Hi</text><path d="M0 0h24v24z"/></svg>';
    const outcome = await converter.convert(svg, buildOptions());
    assert.equal(outcome.status, 'ok', outcome.message);
    assert.deepEqual(
        outcome.warnings.map(({ code, category, node }) => ({ code, category, node })),
        [{ code: 'unsupported-element', category: 'lossy', node: 'text' }],
    );

    const strict = await converter.convert(svg, buildOptions({ strict: 'lossy' }));
    assert.equal(strict.status, 'error');
    assert.equal(strict.code, 'unsupported-element');
    assert.match(describeError(strict), /^\[unsupported-element\] .*\(lossy, rejected by strict mode\)$/);
});

test('a color reference without a preview value is reported as drawn in gray', async (t) => {
    const { converter } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24z"/></svg>';
    const outcome = await converter.convert(svg, buildOptions({ currentColor: '?attr/colorPrimary' }));
    assert.equal(outcome.status, 'ok', outcome.message);
    assert.match(outcome.xml, /android:fillColor="\?attr\/colorPrimary"/);
    assert.match(outcome.preview, /^<svg[^>]*>/);
    assert.deepEqual(outcome.unresolvedColors, ['?attr/colorPrimary']);
    assert.equal(
        describeUnresolvedColors(outcome.unresolvedColors),
        'Drawn in gray (no preview value): ?attr/colorPrimary',
    );

    const literal = await converter.convert(svg, buildOptions({ currentColor: '#FF0000' }));
    assert.deepEqual(literal.unresolvedColors, []);
    assert.equal(describeUnresolvedColors(literal.unresolvedColors), '');
});

test('an invalid SVG reports the error and the worker keeps working', async (t) => {
    const { converter, spawned } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg"><path', 'not an svg', '<div/>']) {
        const outcome = await converter.convert(svg, buildOptions());
        assert.equal(outcome.status, 'error');
        assert.ok(outcome.message.length > 0);
        assert.equal(describeError(outcome), outcome.message);
    }
    const options = await converter.convert(fixture('linear-gradient.svg'), buildOptions({ floatPrecision: '-1' }));
    assert.equal(options.status, 'error');
    assert.match(options.message, /floatPrecision/);
    const after = await converter.convert(fixture('stroke-icon.svg'), buildOptions());
    assert.equal(after.status, 'ok', after.message);
    assert.equal(spawned.length, 1, 'a conversion error must not cost a worker');
});

test('a conversion past the timeout terminates the worker and the next one gets a fresh worker', async (t) => {
    const { converter, spawned } = trackedConverter([spawnHangingWorker, spawnPlaygroundWorker], {
        timeoutMs: 300,
    });
    t.after(converter.dispose);
    const started = Date.now();
    const slow = await converter.convert(fixture('linear-gradient.svg'), buildOptions());
    assert.equal(slow.status, 'timeout');
    assert.match(slow.message, /0\.3 s/);
    assert.ok(Date.now() - started < 2000);
    assert.equal(spawned[0].terminated, true);

    const next = await converter.convert(fixture('linear-gradient.svg'), buildOptions());
    assert.equal(next.status, 'ok', next.message);
    assert.equal(spawned.length, 2);
});

test('a new request supersedes a pending one', async (t) => {
    const { converter, spawned } = trackedConverter([spawnHangingWorker, spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const first = converter.convert('<svg/>', {});
    const second = converter.convert(fixture('clip-path.svg'), buildOptions());
    assert.equal((await first).status, 'superseded');
    assert.equal((await second).status, 'ok');
    assert.equal(spawned[0].terminated, true);
});

test('a worker that cannot start or crashes yields an error outcome', async () => {
    const cannotStart = createConverter(() => {
        throw new Error('SecurityError');
    });
    const outcome = await cannotStart.convert('<svg/>', {});
    assert.equal(outcome.status, 'error');
    assert.match(outcome.message, /could not start \(SecurityError\)/);

    const crashing = createConverter(() => asWebWorker(new Worker("throw new Error('boom');", { eval: true })));
    const crashed = await crashing.convert('<svg/>', {});
    assert.equal(crashed.status, 'error');
    assert.match(crashed.message, /could not run \(boom\)/);
});

test('buildOptions maps the form fields and leaves out empty ones', () => {
    assert.deepEqual(buildOptions(), {});
    assert.deepEqual(buildOptions({ strict: 'off', currentColor: ' ', floatPrecision: '', minSdk: '', tint: '' }), {});
    assert.deepEqual(
        buildOptions({ strict: 'all', currentColor: '#FF0000', floatPrecision: '2', minSdk: '21', tint: '#FFFFFFFF' }),
        { strict: true, currentColor: '#FF0000', floatPrecision: 2, minSdk: 21, tint: '#FFFFFFFF' },
    );
    assert.deepEqual(buildOptions({ strict: 'lossy' }), { strict: 'lossy' });
});

test('the page never parses markup as HTML and loads nothing from another origin', () => {
    const scripts = ['app.js', 'core.js', 'worker.js'].map((name) => readFileSync(here(name), 'utf8')).join('\n');
    assert.doesNotMatch(scripts, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/);
    const html = readFileSync(here('index.html'), 'utf8');
    for (const [, url] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        const isNavigation = /^https:\/\/(github\.com|www\.npmjs\.com)\//.test(url);
        assert.ok(isNavigation || !/^(https?:)?\/\//.test(url), `external resource: ${url}`);
    }
    const workflow = readFileSync(here('../.github/workflows/pages.yml'), 'utf8');
    assert.match(workflow, /cp dist\/browser-lite\.global\.js _site\//);
});
