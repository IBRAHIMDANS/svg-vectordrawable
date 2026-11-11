// Main thread against a fake `figma`: the TypeScript source, then the built dist/code.js.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { isMainToUi, type MainToUi } from '../src/messages.ts';
import { MAX_LAYERS, startPlugin } from '../src/plugin.ts';
import { fakeFigma, fakeNode, fixture, here, waitFor } from './helpers.ts';

const SVG = fixture('figma-frame-radial.svg');
const last = (posted: unknown[]) => posted.at(-1) as MainToUi;

test('opens the UI and exports the selection when the UI says it is ready', async () => {
    const node = fakeNode('1:2', 'Hero / Badge', SVG);
    const figma = fakeFigma([node]);
    const plugin = startPlugin(figma.api, '<html>ui</html>');
    assert.equal(figma.record.shown.length, 1);
    assert.equal(figma.record.shown[0]!.html, '<html>ui</html>');
    assert.deepEqual(figma.record.posted, [], 'nothing is posted before the UI listens');

    figma.fromUi({ type: 'ready' });
    await waitFor(() => figma.record.posted.length === 2);
    const [exporting, selection] = figma.record.posted as MainToUi[];
    assert.deepEqual(exporting, { type: 'exporting', generation: 1, count: 1 });
    assert.ok(isMainToUi(selection) && selection.type === 'selection');
    assert.equal(selection.generation, 1);
    assert.equal(selection.truncated, 0);
    assert.equal(selection.layers.length, 1);
    assert.deepEqual(
        { ...selection.layers[0], svg: undefined },
        {
            id: '1:2',
            name: 'Hero / Badge',
            type: 'FRAME',
            svg: undefined,
        },
    );
    assert.equal(new TextDecoder().decode(selection.layers[0]!.svg), SVG);
    assert.deepEqual(node.calls, [
        { format: 'SVG', svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: true },
    ]);
    await plugin.sendSelection();
});

test('a layer Figma cannot export is reported, the others still go through', async () => {
    const figma = fakeFigma([
        fakeNode('1', 'ok', SVG),
        fakeNode('2', 'broken', new Error('empty group')),
        fakeNode('3', 'ok', SVG),
    ]);
    const plugin = startPlugin(figma.api, '');
    await plugin.sendSelection();
    const selection = last(figma.record.posted);
    assert.equal(selection.type, 'selection');
    const layers = selection.type === 'selection' ? selection.layers : [];
    assert.deepEqual(
        layers.map((layer) => [layer.name, Boolean(layer.svg), layer.error]),
        [
            ['ok', true, undefined],
            ['broken', false, 'Figma could not export this layer as SVG (empty group).'],
            ['ok', true, undefined],
        ],
    );
});

test('a selection change while exporting drops the stale export', async () => {
    let release: () => void = () => {};
    const slow = {
        ...fakeNode('1', 'slow', SVG),
        exportAsync: () => new Promise<Uint8Array>((resolve) => (release = () => resolve(new Uint8Array()))),
    };
    const figma = fakeFigma([slow]);
    startPlugin(figma.api, '');
    figma.emit('selectionchange');
    figma.api.currentPage.selection.splice(0, 1, fakeNode('2', 'fast', SVG));
    figma.emit('selectionchange');
    await waitFor(() => figma.record.posted.some((m) => (m as MainToUi).type === 'selection'));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const selections = figma.record.posted.filter((m) => (m as MainToUi).type === 'selection') as Extract<
        MainToUi,
        { type: 'selection' }
    >[];
    assert.equal(selections.length, 1, 'only the latest selection is posted');
    assert.equal(selections[0]!.generation, 2);
    assert.equal(selections[0]!.layers[0]!.name, 'fast');
});

test(`at most ${MAX_LAYERS} layers are exported; the rest is counted`, async () => {
    const nodes = Array.from({ length: MAX_LAYERS + 3 }, (_, i) => fakeNode(String(i), 'Vector', SVG));
    const figma = fakeFigma(nodes);
    const plugin = startPlugin(figma.api, '');
    await plugin.sendSelection();
    const selection = last(figma.record.posted);
    assert.ok(selection.type === 'selection');
    assert.equal(selection.layers.length, MAX_LAYERS);
    assert.equal(selection.truncated, 3);
    assert.equal(nodes.at(-1)!.calls.length, 0);
});

test('UI messages: refresh re-exports, notify shows a toast, anything else is ignored', async () => {
    const figma = fakeFigma([fakeNode('1', 'a', SVG)]);
    startPlugin(figma.api, '');
    figma.fromUi({ type: 'refresh' });
    await waitFor(() => figma.record.posted.length === 2);
    figma.fromUi({ type: 'notify', message: 'Copied' });
    figma.fromUi({ type: 'notify', message: 'Oops', error: true });
    for (const junk of [null, 'ready', { type: 'eval', code: '1' }, { type: 'notify', message: 42 }])
        figma.fromUi(junk);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(figma.record.notified, [
        { message: 'Copied', options: { error: false } },
        { message: 'Oops', options: { error: true } },
    ]);
    assert.equal(figma.record.posted.length, 2);
});

test('the built dist/code.js runs in a bare sandbox (ES2017, globals figma and __html__ only)', async () => {
    const code = here('../dist/code.js');
    assert.ok(existsSync(code), 'dist/code.js is missing: run `node scripts/build.ts`');
    const source = readFileSync(code, 'utf8');
    // Syntax newer than ES2017 that a restricted engine could reject.
    assert.doesNotMatch(source, /\?\.|\?\?|\.\.\.\w|^\s*(?:import|export)\s/m);
    const figma = fakeFigma([fakeNode('1:1', 'Icon', SVG), fakeNode('1:2', 'Icon', SVG)]);
    const context = vm.createContext({ figma: figma.api, __html__: '<p>ui</p>' });
    vm.runInContext(source, context, { filename: 'code.js' });
    assert.equal(figma.record.shown[0]!.html, '<p>ui</p>');
    assert.ok(figma.api.ui.onmessage, 'listens to the UI');
    figma.fromUi({ type: 'ready' });
    await waitFor(() => figma.record.posted.length === 2);
    // structuredClone: what crossing to the UI does (and the VM realm's arrays become ours).
    const selection = structuredClone(last(figma.record.posted));
    assert.ok(selection.type === 'selection');
    assert.deepEqual(
        selection.layers.map((layer) => layer.name),
        ['Icon', 'Icon'],
        'names are resolved by the UI, not here',
    );
});
