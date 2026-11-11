import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { describeError, runConversion, svgDataUrl } from '../src/conversion.ts';
import { createConverter, type WorkerLike } from '../src/converter.ts';
import { fixture, loadSvgvd } from './helpers.ts';

const svgvd = loadSvgvd();
type Request = Parameters<typeof runConversion>[1];
// structuredClone: the bundle lives in another VM realm; this is also what postMessage does.
const inline = (request: Request) => structuredClone(runConversion(svgvd, request));

test('a Figma frame with a transformed radial gradient, a clip and a #D9D9D9 mask converts exactly', () => {
    // As Figma exports it: unit-circle radial in userSpaceOnUse + gradientTransform, frame clip
    // (`clip0_…`), alpha mask (`mask0_…`, `style="mask-type:alpha"`, #D9D9D9 shape).
    const outcome = inline({ svg: fixture('figma-frame-radial.svg') });
    assert.equal(outcome.status, 'ok', 'message' in outcome ? outcome.message : '');
    assert.deepEqual(outcome.warnings, [], 'no approximation: the ellipse is rendered by a transformed group');
    assert.equal(outcome.minSdk, 24);
    assert.match(outcome.xml, /^<vector /);
    // gradientTransform rotate(45) scale(24 12): baked into a group, not dropped
    assert.match(outcome.xml, /<group\s+android:rotation="45"\s+android:scaleY="0.5">/);
    assert.match(outcome.xml, /android:type="radial"/);
    assert.match(outcome.xml, /android:gradientRadius="24"/);
    assert.match(outcome.xml, /android:color="#FFFF7262"/);
    assert.match(outcome.xml, /android:color="#001ABCFE"/);
    // the mask became a clip-path; the #D9D9D9 mask shape is not painted
    assert.doesNotMatch(outcome.xml, /D9D9D9/i);
    assert.equal((outcome.xml.match(/<clip-path /g) ?? []).length, 2);
    assert.match(outcome.preview ?? '', /^<svg[^>]*>/);
    assert.match(outcome.preview ?? '', /<radialGradient/);
    assert.ok(svgDataUrl(outcome.preview!).startsWith('data:image/svg+xml,%3Csvg'));
});

test('warnings carry their code and category', () => {
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text>Hi</text><path d="M0 0h24v24z"/></svg>';
    const outcome = inline({ svg });
    assert.equal(outcome.status, 'ok');
    assert.deepEqual(
        outcome.warnings.map(({ code, category, node }) => ({ code, category, node })),
        [{ code: 'unsupported-element', category: 'lossy', node: 'text' }],
    );
    const strict = inline({ svg, options: { strict: 'lossy' } });
    assert.equal(strict.status, 'error');
    assert.equal(strict.code, 'unsupported-element');
    assert.match(describeError(strict), /^\[unsupported-element\] .*\(lossy, rejected by strict mode\)$/);
});

test('invalid input is an error outcome, never an exception', () => {
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg"><path', 'not an svg', '<div/>']) {
        const outcome = inline({ svg });
        assert.equal(outcome.status, 'error');
        assert.ok(outcome.message.length > 0);
    }
    const options = inline({ svg: fixture('figma-frame-radial.svg'), options: { floatPrecision: -1 } });
    assert.equal(options.status, 'error');
});

/** A fake worker answering with `runConversion` (or hanging / crashing), recorded in `spawned`. */
function fakeWorker(behaviour: 'convert' | 'hang' | 'crash', spawned: WorkerLike[]): WorkerLike {
    const worker: WorkerLike & { terminated?: boolean } = {
        onmessage: null,
        onerror: null,
        postMessage(data) {
            const { id, ...request } = data as { id: number } & Request;
            if (behaviour === 'convert')
                setTimeout(() => worker.onmessage?.({ data: { id, outcome: inline(request) } }), 0);
            else if (behaviour === 'crash') setTimeout(() => worker.onerror?.({ message: 'CSP: blob: refused' }), 0);
        },
        terminate() {
            worker.terminated = true;
        },
    };
    spawned.push(worker);
    return worker;
}

test('a conversion past the time limit stops its worker; the next one gets a fresh worker', async () => {
    const spawned: WorkerLike[] = [];
    const behaviours = ['hang', 'convert'] as const;
    const converter = createConverter({
        createWorker: () => fakeWorker(behaviours[Math.min(spawned.length, 1)]!, spawned),
        inline,
        timeoutMs: 100,
    });
    const slow = await converter.convert({ svg: fixture('figma-frame-radial.svg') });
    assert.equal(slow.status, 'timeout');
    assert.match(slow.status === 'timeout' ? slow.message : '', /0\.1 s/);
    assert.equal((spawned[0] as { terminated?: boolean }).terminated, true);
    assert.equal(converter.mode, 'worker', 'a timeout is the input, not the environment: no fallback');
    const next = await converter.convert({ svg: fixture('figma-frame-radial.svg') });
    assert.equal(next.status, 'ok');
    assert.equal(spawned.length, 2);
});

test('a real thread that loops forever is terminated on time', async () => {
    const converter = createConverter({
        createWorker: () => {
            const thread = new Worker("require('node:worker_threads').parentPort.on('message', () => { for (;;); });", {
                eval: true,
            });
            return {
                onmessage: null,
                onerror: null,
                postMessage: (data) => thread.postMessage(data),
                terminate: () => void thread.terminate(),
            };
        },
        timeoutMs: 200,
    });
    const started = Date.now();
    assert.equal((await converter.convert({ svg: '<svg/>' })).status, 'timeout');
    assert.ok(Date.now() - started < 2000);
});

test('a newer request supersedes a pending one', async () => {
    const spawned: WorkerLike[] = [];
    const converter = createConverter({
        createWorker: () => fakeWorker(spawned.length === 0 ? 'hang' : 'convert', spawned),
    });
    const first = converter.convert({ svg: '<svg/>' });
    const second = converter.convert({ svg: fixture('figma-frame-radial.svg') });
    assert.equal((await first).status, 'superseded');
    assert.equal((await second).status, 'ok');
    converter.dispose();
});

test('workers refused by the iframe (cannot start, or die at once): falls back to in-page conversion', async () => {
    const cannotStart = createConverter({
        createWorker: () => {
            throw new Error('SecurityError');
        },
        inline,
    });
    assert.equal((await cannotStart.convert({ svg: fixture('figma-frame-radial.svg') })).status, 'ok');
    assert.equal(cannotStart.mode, 'inline');
    assert.equal((await cannotStart.convert({ svg: fixture('figma-frame-radial.svg') })).status, 'ok');

    const spawned: WorkerLike[] = [];
    const crashing = createConverter({ createWorker: () => fakeWorker('crash', spawned), inline });
    assert.equal((await crashing.convert({ svg: fixture('figma-frame-radial.svg') })).status, 'ok');
    assert.equal(crashing.mode, 'inline');
    assert.equal(spawned.length, 1, 'no further worker is tried');
});

test('without a fallback, a broken worker is an error outcome', async () => {
    const converter = createConverter({ createWorker: () => fakeWorker('crash', []) });
    const outcome = await converter.convert({ svg: '<svg/>' });
    assert.equal(outcome.status, 'error');
    assert.match(outcome.status === 'error' ? outcome.message : '', /could not run \(CSP: blob: refused\)/);
});

test('a worker that crashes after having worked reports an error (no silent fallback)', async () => {
    const spawned: WorkerLike[] = [];
    const converter = createConverter({
        createWorker: () => fakeWorker(spawned.length === 0 ? 'convert' : 'crash', spawned),
        inline,
        timeoutMs: 1000,
    });
    assert.equal((await converter.convert({ svg: fixture('figma-frame-radial.svg') })).status, 'ok');
    // force a respawn: supersede a pending request
    const pending = converter.convert({ svg: '<svg/>' });
    converter.dispose();
    assert.equal((await pending).status, 'superseded');
    const crashed = await converter.convert({ svg: '<svg/>' });
    assert.equal(crashed.status, 'error');
    assert.equal(converter.mode, 'worker');
});
