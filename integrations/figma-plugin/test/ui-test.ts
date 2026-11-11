// The UI: first its DOM-free controller, then the built dist/ui.html in a fake page, wired to the
// built dist/code.js running against a fake `figma` (main thread <-> UI messages end to end).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { runConversion, type Outcome } from '../src/conversion.ts';
import { createConverter } from '../src/converter.ts';
import type { ExportedLayer, MainToUi, UiToMain } from '../src/messages.ts';
import { MAX_INPUT_BYTES, createUiController, selectionDownload, statusText } from '../src/ui-controller.ts';
import { FakeBlob, loadPage } from './fake-dom.ts';
import { fakeFigma, fakeNode, fixture, here, loadSvgvd, readZip, spawnWorker, utf8, waitFor } from './helpers.ts';

const svgvd = loadSvgvd();
const SVG = fixture('figma-frame-radial.svg');
const TEXT_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>Hi</text><path d="M0 0h24v24z"/></svg>';

function controllerHarness() {
    const posted: UiToMain[] = [];
    const renders: string[] = [];
    const converter = createConverter({
        createWorker: () => {
            throw new Error('no workers in this test');
        },
        inline: (request) => structuredClone(runConversion(svgvd, request)),
    });
    const controller = createUiController({
        post: (message) => posted.push(message),
        converter,
        render: (state) => renders.push(state.phase),
    });
    return { controller, posted, renders };
}

const layer = (id: string, name: string, svg?: string, error?: string): ExportedLayer => ({
    id,
    name,
    type: 'FRAME',
    ...(svg === undefined ? {} : { svg: utf8(svg) }),
    ...(error === undefined ? {} : { error }),
});

const selection = (generation: number, layers: ExportedLayer[], truncated = 0): MainToUi => ({
    type: 'selection',
    generation,
    layers,
    truncated,
});

const okXml = (outcome: Outcome | null): string => (outcome?.status === 'ok' ? outcome.xml : '');

test('a multiple selection: each layer converted, distinct names, one zip with drawable/<name>.xml', async () => {
    const { controller, posted } = controllerHarness();
    controller.start();
    assert.deepEqual(posted, [{ type: 'ready' }]);
    await controller.handle({ type: 'exporting', generation: 1, count: 4 });
    assert.equal(statusText(controller.state).text, 'Exporting 4 layers from Figma…');
    await controller.handle(
        selection(1, [
            layer('1', 'Icon / Badge', SVG),
            layer('2', 'icon-badge', SVG),
            layer('3', 'Icon Badge', TEXT_SVG),
            layer('4', 'Broken', undefined, 'Figma could not export this layer as SVG (x).'),
        ]),
    );
    const { state } = controller;
    assert.equal(state.phase, 'done');
    assert.deepEqual(
        state.layers.map((l) => [l.resourceName, l.outcome?.status]),
        [
            ['icon_badge', 'ok'],
            ['icon_badge_2', 'ok'],
            ['icon_badge_3', 'ok'],
            ['broken', 'error'],
        ],
    );
    assert.deepEqual(statusText(state), { text: '3/4 converted, 1 with warnings, 1 failed.', kind: 'error' });

    const file = selectionDownload(state, new Date(2026, 10, 11));
    assert.ok(file);
    assert.equal(file.filename, 'drawables.zip');
    assert.equal(file.mimeType, 'application/zip');
    const entries = readZip(file.data as Uint8Array, zlib.crc32);
    assert.deepEqual(
        [...entries.keys()],
        ['drawable/icon_badge.xml', 'drawable/icon_badge_2.xml', 'drawable/icon_badge_3.xml'],
    );
    const xml = new TextDecoder().decode(entries.get('drawable/icon_badge.xml'));
    assert.equal(xml, okXml(state.layers[0]!.outcome), 'the converter output ends with a newline already');
    assert.match(xml, /android:type="radial"/);
});

test('a single converted layer downloads as <name>.xml', async () => {
    const { controller } = controllerHarness();
    await controller.handle(selection(1, [layer('1', 'Logo', SVG), layer('2', 'Nope', undefined, 'no')]));
    const file = selectionDownload(controller.state);
    assert.deepEqual(
        { ...file, data: undefined },
        { filename: 'logo.xml', mimeType: 'application/xml', data: undefined },
    );
    assert.match(String(file?.data), /^<vector [\s\S]*<\/vector>\n$/);
});

test('an export over the size limit is not converted', async () => {
    const { controller } = controllerHarness();
    const huge = `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(MAX_INPUT_BYTES)}--></svg>`;
    await controller.handle(selection(1, [layer('1', 'Photo', huge)]));
    const [view] = controller.state.layers;
    assert.equal(view!.outcome?.status, 'error');
    assert.match(view!.outcome?.status === 'error' ? view!.outcome.message : '', /larger than 2 MB/);
    assert.equal(view!.sourceSvg, null);
    assert.equal(selectionDownload(controller.state), null);
});

test('an empty selection, stale and malformed messages', async () => {
    const { controller } = controllerHarness();
    await controller.handle(selection(2, []));
    assert.equal(controller.state.phase, 'waiting');
    assert.match(statusText(controller.state).text, /^Select one or more layers/);
    await controller.handle(selection(1, [layer('1', 'old', SVG)]));
    assert.equal(controller.state.layers.length, 0, 'an older generation is ignored');
    for (const junk of [undefined, null, 'x', { type: 'selection' }, { type: 'exporting', generation: 'a' }])
        await controller.handle(junk);
    assert.equal(controller.state.phase, 'waiting');
    controller.refresh();
    controller.notify('hello');
});

test('a newer selection supersedes the conversion in progress', async () => {
    const posted: UiToMain[] = [];
    let release: (outcome: Outcome) => void = () => {};
    const calls: string[] = [];
    const controller = createUiController({
        post: (message) => posted.push(message),
        converter: {
            convert: ({ svg }) => {
                calls.push(svg);
                if (svg === 'slow') return new Promise((resolve) => (release = resolve));
                return Promise.resolve(structuredClone(runConversion(svgvd, { svg })));
            },
        },
        render: () => {},
    });
    const first = controller.handle(selection(1, [layer('1', 'a', 'slow'), layer('2', 'b', SVG)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.handle(selection(2, [layer('3', 'c', SVG)]));
    release({ status: 'superseded' });
    await first;
    assert.deepEqual(calls, ['slow', SVG], 'the old loop stopped: layer "b" was never converted');
    assert.deepEqual(
        controller.state.layers.map((l) => [l.layerName, l.outcome?.status]),
        [['c', 'ok']],
    );
});

/** dist/code.js (fake figma) <-> dist/ui.html (fake page), the way Figma relays messages. */
function plugin(nodes: ReturnType<typeof fakeNode>[], withWorker: boolean) {
    const html = here('../dist/ui.html');
    const code = here('../dist/code.js');
    assert.ok(existsSync(html) && existsSync(code), 'dist/ is missing: run `node scripts/build.ts`');
    const figma = fakeFigma(nodes);
    const spawned: { terminated: boolean }[] = [];
    // The page first: its `ready` reaches the main thread on a later tick, once code.js listens.
    const page = loadPage(readFileSync(html, 'utf8'), {
        // UI -> main: `parent.postMessage({ pluginMessage }, '*')` reaches `figma.ui.onmessage`
        toMain: (message) => setTimeout(() => figma.fromUi(message), 0),
        ...(withWorker ? { spawnWorker: (source: string) => spawnWorker(source, spawned) } : {}),
    });
    // main -> UI: Figma delivers `figma.ui.postMessage(msg)` as `event.data.pluginMessage`
    figma.api.ui.postMessage = (message) => {
        figma.record.posted.push(message);
        setTimeout(() => page.fromMain(message), 0);
    };
    vm.runInContext(readFileSync(code, 'utf8'), vm.createContext({ figma: figma.api, __html__: 'ui.html' }));
    return { figma, page, spawned };
}

const isDone = (page: ReturnType<typeof loadPage>) => () =>
    /converted/.test(page.el('status').textContent) && !/Converting/.test(page.el('status').textContent);

for (const withWorker of [true, false]) {
    test(`built plugin, ${withWorker ? 'blob: worker' : 'no Worker API (in-page fallback)'}: select, convert, show, copy, download`, async (t) => {
        const { figma, page, spawned } = plugin(
            [fakeNode('1:1', 'Icons / Badge', SVG), fakeNode('1:2', 'icons-badge', TEXT_SVG, 'COMPONENT')],
            withWorker,
        );
        t.after(() => page.workers.forEach((worker) => worker.terminate()));
        assert.deepEqual(page.parentPosts[0], { message: { pluginMessage: { type: 'ready' } }, targetOrigin: '*' });
        await waitFor(isDone(page), 8000);

        assert.equal(page.el('status').textContent, '2/2 converted, 1 with warnings.');
        assert.equal(page.el('status').dataset.kind, 'warn');
        assert.equal(spawned.length, withWorker ? 1 : 0);
        // the layer list: both layers, distinct file names
        const files = page
            .el('layers')
            .findAll((e) => e.tagName === 'code')
            .map((e) => e.textContent);
        assert.deepEqual(files, ['icons_badge.xml', 'icons_badge_2.xml']);
        // detail of the first layer: XML, no warnings, both previews as data: images
        assert.equal(page.el('detail').hidden, false);
        assert.equal(page.el('layer-title').textContent, 'Icons / Badge → icons_badge.xml');
        assert.match(page.el('xml').value, /^<vector [\s\S]*android:type="radial"/);
        assert.equal(page.el('warnings').textContent, 'None: the drawable represents the layer faithfully.');
        for (const id of ['source-preview', 'vd-preview']) {
            const [img] = page.el(id).findAll((e) => e.tagName === 'img');
            assert.ok(img, `${id} shows an <img>`);
            assert.match(img.src, /^data:image\/svg\+xml,%3Csvg/);
        }
        // select the second layer: its warning, with code and category
        page.el('layers')
            .findAll((e) => e.tagName === 'button')[1]!
            .click();
        assert.equal(page.el('layer-title').textContent, 'icons-badge → icons_badge_2.xml');
        const [warning] = page.el('warnings').findAll((e) => e.tagName === 'li');
        const [code, badge] = warning!.findAll(() => true);
        assert.equal(code!.textContent, 'unsupported-element');
        assert.equal(badge!.textContent, 'lossy');
        assert.equal(badge!.dataset.category, 'lossy');

        // copy: execCommand on the selected textarea, then a Figma toast
        page.el('copy').click();
        assert.deepEqual(page.document.commands, ['copy']);
        assert.equal(page.el('xml').selected, true);
        await waitFor(() => figma.record.notified.length === 1);
        assert.deepEqual(figma.record.notified[0], { message: 'VectorDrawable XML copied', options: { error: false } });

        // download one layer, then all of them (zip)
        page.el('download-layer').click();
        page.el('download-all').click();
        assert.deepEqual(
            page.document.downloads.map((d) => d.download),
            ['icons_badge_2.xml', 'drawables.zip'],
        );
        const zipBlob = page.blobs.get(page.document.downloads[1]!.href) as FakeBlob;
        assert.equal(zipBlob.type, 'application/zip');
        assert.deepEqual(
            [...readZip(zipBlob.bytes(), zlib.crc32).keys()],
            ['drawable/icons_badge.xml', 'drawable/icons_badge_2.xml'],
        );
        assert.deepEqual(page.networkCalls, [], 'works without network');
    });
}

test('built plugin: a selection change in Figma re-exports and re-renders', async (t) => {
    const nodes = [fakeNode('1:1', 'First', SVG)];
    const { figma, page } = plugin(nodes, true);
    t.after(() => page.workers.forEach((worker) => worker.terminate()));
    await waitFor(isDone(page), 8000);
    figma.api.currentPage.selection.splice(0, 1);
    figma.emit('selectionchange');
    await waitFor(() => /^Select one or more layers/.test(page.el('status').textContent));
    assert.equal(page.el('detail').hidden, true);
    assert.equal(page.el('download-all').disabled, true);
    figma.api.currentPage.selection.push(fakeNode('2:1', 'Second', SVG), fakeNode('2:2', 'Third', SVG));
    figma.emit('selectionchange');
    await waitFor(isDone(page), 8000);
    assert.equal(page.el('download-all').textContent, 'Download all (.zip)');
    page.el('refresh').click();
    await waitFor(() => figma.record.posted.length === 8); // 4 exports: ready, change, change, refresh
});

test('built plugin: copy blocked by the iframe leaves the XML selected with a hint', async (t) => {
    const { page, figma } = plugin([fakeNode('1:1', 'One', SVG)], false);
    t.after(() => page.workers.forEach((worker) => worker.terminate()));
    await waitFor(isDone(page), 8000);
    page.document.copyAllowed = false;
    page.el('copy').click();
    assert.match(page.el('status').textContent, /press Ctrl\+C/);
    assert.equal(figma.record.notified.length, 0);
});

test('the page builds DOM nodes only (never parses markup) and keeps scripts inline', () => {
    const sources = ['ui.ts', 'ui-controller.ts', 'conversion.ts', 'converter.ts', 'worker.ts']
        .map((name) => readFileSync(here(`../src/${name}`), 'utf8'))
        .join('\n');
    assert.doesNotMatch(sources, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|\beval\(/);
});
