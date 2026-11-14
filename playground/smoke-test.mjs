// Smoke test of the playground against the current build: `pnpm build && node --test playground/smoke-test.mjs`.
// worker.js runs in a real thread (worker_threads + a tiny shim for importScripts / postMessage), driven
// by core.js exactly as the page does. Named *-test.mjs, not *.test.mjs, so vitest does not collect it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
    CLI_SNIPPETS,
    buildOptions,
    createConverter,
    describeApiLevel,
    describeConversion,
    describeError,
    describeSize,
    effectiveFormat,
    describeUnresolvedColors,
    formatBytes,
    isVectorDrawable,
    outputFileName,
    parsePreviewColors,
    resourceFileName,
    svgDataUrl,
    tokenizeXml,
    warningHelpUrl,
} from './core.js';
import { EXAMPLES } from './examples.js';

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
        'VectorDrawable result: drawn in gray (no preview value): ?attr/colorPrimary',
    );

    const literal = await converter.convert(svg, buildOptions({ currentColor: '#FF0000' }));
    assert.deepEqual(literal.unresolvedColors, []);
    assert.equal(describeUnresolvedColors(literal.unresolvedColors), '');
});

test('a reference given a preview color is drawn with it and no longer reported as gray', async (t) => {
    const { converter } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h12v12z"/>' +
        '<path fill="#00FF00" d="M12 12h12v12z"/></svg>';
    const options = buildOptions({ currentColor: '?attr/colorPrimary' });
    const covered = await converter.convert(svg, options, {
        colors: parsePreviewColors('?attr/colorPrimary=#6750A4'),
    });
    assert.equal(covered.status, 'ok', covered.message);
    assert.match(covered.xml, /android:fillColor="\?attr\/colorPrimary"/);
    assert.match(covered.preview, /fill="#6750a4"/i);
    assert.deepEqual(covered.unresolvedColors, []);
    assert.equal(describeUnresolvedColors(covered.unresolvedColors), '');

    // A pair for another reference leaves this one gray (the XML itself never changes).
    const other = await converter.convert(svg, options, { colors: parsePreviewColors('@color/brand=#FF0000') });
    assert.deepEqual(other.unresolvedColors, ['?attr/colorPrimary']);
    assert.equal(other.xml, covered.xml);

    // A malformed value is the library's preview error, shown as is; the conversion still succeeds.
    const malformed = await converter.convert(svg, options, { colors: parsePreviewColors('?attr/colorPrimary=blue') });
    assert.equal(malformed.status, 'ok');
    assert.equal(malformed.preview, null);
    assert.match(malformed.previewError, /^Invalid colors\["\?attr\/colorPrimary"\]: "blue"/);
});

test('parsePreviewColors reads reference=color pairs', () => {
    assert.deepEqual(parsePreviewColors(), {});
    assert.deepEqual(parsePreviewColors(' , ;\n'), {});
    assert.deepEqual(parsePreviewColors(' ?attr/colorPrimary = #6750A4 , @color/brand=#F00;\n?attr/x=#1234'), {
        '?attr/colorPrimary': '#6750A4',
        '@color/brand': '#F00',
        '?attr/x': '#1234',
    });
    // The last pair wins; a pair without `=` keeps an empty color, which the library rejects by name.
    assert.deepEqual(parsePreviewColors('?attr/a=#000, ?attr/a=#FFF, ?attr/b'), { '?attr/a': '#FFF', '?attr/b': '' });
    // One pair per line, as typed in the multi-line field (Windows line ends included).
    assert.deepEqual(parsePreviewColors('?attr/a=#000\r\n@color/b=#FFF\n'), { '?attr/a': '#000', '@color/b': '#FFF' });
});

test('the Preview colors field is multi-line and the gray note leads to it', () => {
    const html = readFileSync(here('index.html'), 'utf8');
    assert.match(html, /<textarea\s+id="opt-preview-colors"/);
    const app = readFileSync(here('app.js'), 'utf8');
    assert.match(app, /getElementById\('opt-preview-colors'\)/);
    assert.match(app, /setAttribute\('aria-controls', 'opt-preview-colors'\)/);
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

test('every example converts, and only the one meant to shows warnings', async (t) => {
    const { converter } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const warnings = {};
    for (const example of EXAMPLES) {
        const outcome = await converter.convert(example.svg, buildOptions());
        assert.equal(outcome.status, 'ok', `${example.id}: ${outcome.message}`);
        assert.match(outcome.preview, /^<svg[^>]*>/, example.id);
        warnings[example.id] = outcome.warnings.map((warning) => warning.code);
    }
    assert.deepEqual(warnings, {
        gradient: [],
        stroke: [],
        clip: [],
        unsupported: ['unsupported-attribute', 'unsupported-element'],
        drawable: [],
    });
});

test('tokenizeXml colors tags, attributes and values without changing the text', async (t) => {
    const { converter } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const { xml } = await converter.convert(fixture('linear-gradient.svg'), buildOptions());
    const tokens = tokenizeXml(xml);
    assert.equal(tokens.map((token) => token.text).join(''), xml);
    assert.deepEqual(tokenizeXml('<!-- a="b" --><path\n    android:pathData="M0,0 L1,1" />'), [
        { type: 'comment', text: '<!-- a="b" -->' },
        { type: 'tag', text: '<path' },
        { type: 'text', text: '\n    ' },
        { type: 'attr', text: 'android:pathData' },
        { type: 'text', text: '=' },
        { type: 'value', text: '"M0,0 L1,1"' },
        { type: 'text', text: ' ' },
        { type: 'tag', text: '/>' },
    ]);
    assert.deepEqual(tokenizeXml(''), []);
});

test('the download name follows the library resource naming (src/resourceName.ts)', async () => {
    const LIBRARY = here('../dist/index.js');
    assert.ok(existsSync(LIBRARY), 'dist/index.js is missing: run `pnpm build` first');
    const { androidResourceName } = await import(LIBRARY);
    for (const name of ['new', 'class', 'XMLParser', '24-hours', 'café', 'Arrow-Left', 'icCloséState', 'true']) {
        assert.equal(resourceFileName(`${name}.svg`), `${androidResourceName(name)}.xml`, name);
    }
    assert.equal(resourceFileName('new.svg'), 'new_.xml');
    assert.equal(resourceFileName('XMLParser.svg'), 'xml_parser.xml');
    // Only deliberate difference: an empty name falls back to ic_drawable, not the library's `ic`.
    assert.equal(androidResourceName('__'), 'ic');
    assert.equal(resourceFileName('__.svg'), 'ic_drawable.xml');
});

test('the download name is an Android resource name; sizes are readable', () => {
    assert.equal(resourceFileName('Arrow-Left.svg'), 'arrow_left.xml');
    assert.equal(resourceFileName('icCloséState.SVG'), 'ic_close_state.xml');
    assert.equal(resourceFileName('24px.svg'), 'ic_24px.xml');
    assert.equal(resourceFileName(''), 'ic_drawable.xml');
    assert.equal(resourceFileName('---.svg'), 'ic_drawable.xml');
    assert.equal(formatBytes(812), '812 B');
    assert.equal(formatBytes(1488), '1.5 kB');
    assert.equal(formatBytes(2_400_000), '2.4 MB');
    assert.equal(describeSize('<vector android:width="24dp"\n android:height="12.5dp">'), '24 × 12.5 dp');
    assert.equal(describeSize('<vector>'), '');
});

test('the page never parses markup as HTML and loads nothing from another origin', () => {
    const scripts = ['app.js', 'core.js', 'examples.js', 'worker.js']
        .map((name) => readFileSync(here(name), 'utf8'))
        .join('\n');
    assert.doesNotMatch(scripts, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/);
    const html = readFileSync(here('index.html'), 'utf8');
    for (const [, url] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        const isNavigation = /^https:\/\/(github\.com|www\.npmjs\.com)\//.test(url);
        assert.ok(isNavigation || !/^(https?:)?\/\//.test(url), `external resource: ${url}`);
    }
    const workflow = readFileSync(here('../.github/workflows/pages.yml'), 'utf8');
    assert.match(workflow, /cp dist\/browser-lite\.global\.js _site\//);
    // Every file the page loads must be copied to the published site.
    const loaded = [...html.matchAll(/\b(?:src|href)="([^":]+\.[a-z]+)"/g)].map(([, url]) => url);
    for (const name of [...loaded, 'core.js', 'examples.js', 'worker.js']) {
        assert.ok(workflow.includes(`playground/${name}`), `pages.yml does not publish ${name}`);
    }
});

test('every option has a visible hint, referenced by its control (T-188)', () => {
    const html = readFileSync(here('./index.html'), 'utf8');
    const fieldset = html.slice(html.indexOf('<fieldset id="settings"'), html.indexOf('</fieldset>'));
    const controls = [...fieldset.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(controls.length >= 6, 'the options are found');
    for (const control of controls) {
        const id = /\sid="([^"]+)"/.exec(control)?.[1];
        const describedBy = /aria-describedby="([^"]+)"/.exec(control)?.[1];
        assert.equal(describedBy, `${id}-hint`, `${id} is described by its hint`);
        assert.match(
            fieldset,
            new RegExp(`<span id="${describedBy}" class="field-hint"\\s*>\\s*\\S`),
            `${id} has a hint`,
        );
    }
});

test('the guide sections exist, and the command-line card covers four package managers (T-188)', () => {
    const html = readFileSync(here('./index.html'), 'utf8');
    for (const id of ['use', 'coverage', 'api-note', 'cli-snippet']) assert.match(html, new RegExp(`id="${id}"`));
    assert.ok(html.includes('href="#use"') && html.includes('href="#coverage"'), 'the nav links to the sections');
    assert.deepEqual(Object.keys(CLI_SNIPPETS), ['npm', 'pnpm', 'yarn', 'bun']);
    for (const [pm, snippet] of Object.entries(CLI_SNIPPETS)) {
        assert.match(snippet, /svg-vectordrawable\n/, `${pm} installs the package`);
        assert.match(snippet, /svgvd icons\/ -o app\/src\/main\/res\/drawable$/, `${pm} runs the CLI`);
        assert.match(html, new RegExp(`name="pm" value="${pm}"`), `${pm} has a switch`);
    }
});

test('describeApiLevel says what the drawable needs', () => {
    assert.match(describeApiLevel(null), /Convert an SVG/);
    assert.match(describeApiLevel(21), /from API 21/);
    assert.match(describeApiLevel(24), /needs API 24.*app:srcCompat/);
});

test('the status says what the warnings mean, worst category first (T-188)', () => {
    assert.deepEqual(describeConversion(21, []), { text: 'Converted for API 21+: faithful, no warning.', tone: 'ok' });
    const w = (category) => ({ code: 'x', message: '', category });
    assert.match(describeConversion(24, [w('info')]).text, /faithful; 1 note below/);
    assert.match(
        describeConversion(24, [w('approximation'), w('info')]).text,
        /with 1 approximation: close to the SVG/,
    );
    const lossy = describeConversion(24, [w('approximation'), w('lossy'), w('lossy')]);
    assert.match(lossy.text, /but 2 lossy warnings: part of the SVG is missing or drawn wrong/);
    assert.equal(lossy.tone, 'warn');
});

test('each warning links to its explanation in docs/warnings.md, which has a section per code (T-188)', () => {
    const doc = readFileSync(here('../docs/warnings.md'), 'utf8');
    const documented = [...doc.matchAll(/^### `([a-z-]+)`$/gm)].map((m) => m[1]);
    assert.ok(documented.length >= 20);
    for (const code of documented) {
        assert.equal(
            warningHelpUrl(code),
            `https://github.com/IBRAHIMDANS/svg-vectordrawable/blob/main/docs/warnings.md#${code}`,
        );
    }
    assert.equal(warningHelpUrl('not a code'), null);
    assert.equal(warningHelpUrl(undefined), null);
});

test('the output format follows the input: Compose from both, SVG from a drawable only (T-188)', async (t) => {
    const { converter } = trackedConverter([spawnPlaygroundWorker]);
    t.after(converter.dispose);
    const svg = EXAMPLES.find((e) => e.id === 'gradient').svg;
    const drawable = EXAMPLES.find((e) => e.id === 'drawable').svg;
    assert.equal(isVectorDrawable(svg), false);
    assert.equal(isVectorDrawable(drawable), true);
    assert.equal(isVectorDrawable('<?xml version="1.0"?>\n<!-- icon -->\n<vector android:width="24dp"/>'), true);
    assert.deepEqual(
        [effectiveFormat('vector', false), effectiveFormat('svg', false), effectiveFormat('compose', false)],
        ['vector', 'vector', 'compose'],
    );
    assert.deepEqual(
        [effectiveFormat('vector', true), effectiveFormat('svg', true), effectiveFormat('compose', true)],
        ['svg', 'svg', 'compose'],
    );

    const compose = await converter.convert(svg, buildOptions(), {}, { format: 'compose', name: 'gradient-icon' });
    assert.equal(compose.status, 'ok', compose.message);
    assert.equal(compose.format, 'compose');
    assert.equal(compose.kotlinName, 'GradientIcon');
    assert.match(compose.output, /val GradientIcon: ImageVector by lazy/);
    assert.match(compose.preview, /^<svg/);

    const fromDrawable = await converter.convert(
        drawable,
        buildOptions(),
        {},
        { format: 'compose', name: 'ic_favorite' },
    );
    assert.equal(fromDrawable.status, 'ok', fromDrawable.message);
    assert.equal(fromDrawable.input, 'vectordrawable');
    assert.match(fromDrawable.output, /val IcFavorite: ImageVector/);
    assert.match(fromDrawable.sourcePreview, /^<svg/);

    const back = await converter.convert(drawable, buildOptions(), {}, { format: 'svg' });
    assert.equal(back.format, 'svg');
    assert.match(back.output, /^<svg[^>]*viewBox="0 0 24 24"/);
    assert.equal(back.minSdk, null);

    assert.deepEqual(
        [
            outputFileName('vector', 'Arrow Left.svg'),
            outputFileName('svg', 'ic_favorite.xml'),
            outputFileName('compose', 'x.svg', 'GradientIcon'),
        ],
        ['arrow_left.xml', 'ic_favorite.svg', 'GradientIcon.kt'],
    );
});

test('the command-line options table lists every option of svgvd --help (T-188)', () => {
    const help = execFileSync(process.execPath, [here('../dist/cli.js'), '--help'], { encoding: 'utf8' });
    const flags = [...new Set([...help.matchAll(/^\s{2}(?:-\w, )?(--[a-z-]+(?:=lossy)?)/gm)].map((m) => m[1]))];
    assert.ok(flags.length >= 25, `flags found: ${flags.length}`);
    const html = readFileSync(here('./index.html'), 'utf8');
    const table = html.slice(html.indexOf('<table class="options-table"'), html.indexOf('</table>'));
    for (const flag of flags)
        assert.ok(table.includes(`<code>${flag}`) || table.includes(`, ${flag}`), `${flag} is in the table`);
});
