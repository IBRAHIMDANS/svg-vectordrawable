// Test doubles: the lite bundle loaded in a VM context (no network globals at all), fake Figma
// nodes / API, and a worker_threads stand-in for the UI's blob: Web Worker.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import type { SvgvdLib } from '../src/conversion.ts';
import type { WorkerLike } from '../src/converter.ts';

export const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
export const LITE_BUNDLE = here('../../../dist/browser-lite.global.js');

export function readLiteBundle(): string {
    if (!existsSync(LITE_BUNDLE)) throw new Error(`${LITE_BUNDLE} is missing: run \`pnpm run build\` at the root.`);
    return readFileSync(LITE_BUNDLE, 'utf8');
}

/** The `svgvd` global of dist/browser-lite.global.js, evaluated in a context without fetch & co. */
export function loadSvgvd(): SvgvdLib {
    const context: { svgvd?: SvgvdLib } = {};
    vm.createContext(context);
    vm.runInContext(readLiteBundle(), context, { filename: 'browser-lite.global.js' });
    if (!context.svgvd) throw new Error('the bundle did not define svgvd');
    return context.svgvd;
}

export const fixture = (name: string): string => readFileSync(here(`fixtures/${name}`), 'utf8');
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A Figma scene node whose `exportAsync` returns `svg` (or rejects with `error`). */
export function fakeNode(id: string, name: string, svg: string | Error, type = 'FRAME') {
    const calls: unknown[] = [];
    return {
        id,
        name,
        type,
        calls,
        exportAsync(settings: unknown): Promise<Uint8Array> {
            calls.push(settings);
            return svg instanceof Error ? Promise.reject(svg) : Promise.resolve(utf8(svg));
        },
    };
}

/** A fake `figma` global: records what the plugin shows, posts and notifies. */
export function fakeFigma(selection: ReturnType<typeof fakeNode>[] = []) {
    const listeners: Record<string, (() => void)[]> = {};
    const record = {
        posted: [] as unknown[],
        notified: [] as { message: string; options: unknown }[],
        shown: [] as { html: string; options: unknown }[],
    };
    const api = {
        currentPage: { selection },
        ui: {
            onmessage: undefined as ((message: unknown) => void) | undefined,
            postMessage: (message: unknown) => {
                record.posted.push(message);
            },
        },
        showUI: (html: string, options: unknown) => {
            record.shown.push({ html, options });
        },
        on: (event: string, callback: () => void) => {
            (listeners[event] ??= []).push(callback);
        },
        notify: (message: string, options: unknown) => {
            record.notified.push(structuredClone({ message, options })); // code.js may run in a VM realm
        },
    };
    return {
        api,
        record,
        emit: (event: string) => listeners[event]?.forEach((callback) => callback()),
        /** The UI sending `message` to the main thread. */
        fromUi: (message: unknown) => api.ui.onmessage?.(message),
    };
}

/**
 * Runs `source` (the UI's blob: worker: bundle + worker build) in a real thread, behind the Web
 * Worker surface. `fetch` and friends throw there, so a network access would fail the conversion.
 */
export function spawnWorker(source: string, spawned: { terminated: boolean }[] = []): WorkerLike {
    const shim = `
        const { parentPort, workerData } = require('node:worker_threads');
        const vm = require('node:vm');
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'])
            globalThis[name] = () => { throw new Error('network access: ' + name); };
        globalThis.self = globalThis;
        globalThis.postMessage = (data) => parentPort.postMessage(data);
        vm.runInThisContext(workerData.source, { filename: 'blob-worker.js' });
        parentPort.on('message', (data) => self.onmessage({ data }));
    `;
    const thread = new Worker(shim, { eval: true, workerData: { source } });
    thread.unref(); // a thread a failed test left behind must not keep the run alive
    const worker: WorkerLike & { terminated: boolean } = {
        onmessage: null,
        onerror: null,
        terminated: false,
        postMessage: (data) => thread.postMessage(data),
        terminate: () => {
            worker.terminated = true;
            void thread.terminate();
        },
    };
    thread.on('message', (data: unknown) => worker.onmessage?.({ data }));
    thread.on('error', (error: Error) => worker.onerror?.({ message: error.message }));
    spawned.push(worker);
    return worker;
}

/** Resolves once `condition()` holds (polled), or rejects after `timeoutMs`. */
export async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Reads back a stored ZIP (independent of src/zip.ts): path -> bytes, with CRC and sizes checked. */
export function readZip(zip: Uint8Array, crc32: (data: Uint8Array) => number): Map<string, Uint8Array> {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const end = zip.byteLength - 22;
    if (view.getUint32(end, true) !== 0x06054b50) throw new Error('no end of central directory');
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const files = new Map<string, Uint8Array>();
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
        if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central header');
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extra = view.getUint16(at + 30, true);
        const comment = view.getUint16(at + 32, true);
        const local = view.getUint32(at + 42, true);
        const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
        if (method !== 0) throw new Error('not stored');
        if (view.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
        const localName = view.getUint16(local + 26, true);
        const localExtra = view.getUint16(local + 28, true);
        const start = local + 30 + localName + localExtra;
        const data = zip.subarray(start, start + size);
        if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
        files.set(name, data);
        at += 46 + nameLength + extra + comment;
    }
    return files;
}
