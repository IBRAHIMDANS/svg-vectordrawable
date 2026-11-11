// A tiny DOM stand-in, just enough to run dist/ui.html's inline scripts in a VM context: elements
// are created from the `id`s found in the markup, and every DOM call ui.ts makes is recorded.
import vm from 'node:vm';
import type { WorkerLike } from '../src/converter.ts';

type Listener = (event: Record<string, unknown>) => void;

export class FakeElement {
    readonly children: (FakeElement | string)[] = [];
    readonly dataset: Record<string, string> = {};
    readonly attributes: Record<string, string> = {};
    private readonly listeners: Record<string, Listener[]> = {};
    private text = '';
    parent: FakeElement | null = null;
    value = '';
    disabled = false;
    hidden = false;
    className = '';
    type = '';
    src = '';
    alt = '';
    href = '';
    download = '';
    selected = false;

    readonly tagName: string;
    readonly id: string;
    private readonly document: FakeDocument | undefined;

    // No parameter properties: Node's type stripping only erases plain annotations.
    constructor(tagName: string, id = '', document?: FakeDocument) {
        this.tagName = tagName;
        this.id = id;
        this.document = document;
    }

    get textContent(): string {
        return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    set textContent(value: string) {
        this.children.length = 0;
        this.text = value;
    }
    append(...nodes: (FakeElement | string)[]): void {
        for (const node of nodes) {
            if (typeof node !== 'string') node.parent = this;
            this.children.push(node);
        }
    }
    replaceChildren(...nodes: (FakeElement | string)[]): void {
        this.children.length = 0;
        this.text = '';
        this.append(...nodes);
    }
    remove(): void {
        if (!this.parent) return;
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }
    setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
    }
    addEventListener(type: string, listener: Listener): void {
        (this.listeners[type] ??= []).push(listener);
    }
    dispatch(type: string, event: Record<string, unknown> = {}): void {
        for (const listener of this.listeners[type] ?? []) listener({ type, target: this, ...event });
    }
    click(): void {
        if (this.disabled) return;
        if (this.tagName === 'a' && this.download)
            this.document?.downloads.push({ href: this.href, download: this.download });
        this.dispatch('click');
    }
    focus(): void {}
    select(): void {
        this.selected = true;
    }
    /** Element descendants matching `predicate`, depth first. */
    findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
        const found: FakeElement[] = [];
        for (const child of this.children) {
            if (typeof child === 'string') continue;
            if (predicate(child)) found.push(child);
            found.push(...child.findAll(predicate));
        }
        return found;
    }
}

export class FakeDocument {
    readonly byId = new Map<string, FakeElement>();
    readonly body = new FakeElement('body');
    readonly downloads: { href: string; download: string }[] = [];
    readonly commands: string[] = [];
    copyAllowed = true;

    getElementById(id: string): FakeElement | null {
        return this.byId.get(id) ?? null;
    }
    createElement(tag: string): FakeElement {
        return new FakeElement(tag, '', this);
    }
    execCommand(command: string): boolean {
        this.commands.push(command);
        return this.copyAllowed;
    }
}

/** A Blob that keeps its parts, so tests can read what the page downloads or runs as a worker. */
export class FakeBlob {
    readonly parts: unknown[];
    readonly options: { type?: string };

    constructor(parts: unknown[], options: { type?: string } = {}) {
        this.parts = parts;
        this.options = options;
    }
    get type(): string {
        return this.options.type ?? '';
    }
    bytes(): Uint8Array {
        const chunks = this.parts.map((part) =>
            typeof part === 'string' ? new TextEncoder().encode(part) : (part as Uint8Array),
        );
        const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
        let at = 0;
        for (const chunk of chunks) {
            out.set(chunk, at);
            at += chunk.byteLength;
        }
        return out;
    }
    text(): string {
        return new TextDecoder().decode(this.bytes());
    }
}

export interface PageOptions {
    /** Called with the worker source (bundle + worker build) when the page starts a Worker; omit for no Worker API. */
    spawnWorker?: (source: string) => WorkerLike;
    /** Receives what the page posts to `parent` (i.e. to the plugin's main thread). */
    toMain: (pluginMessage: unknown) => void;
}

/** Loads dist/ui.html into a fake page. Network APIs exist but throw and are recorded. */
export function loadPage(html: string, { spawnWorker, toMain }: PageOptions) {
    const document = new FakeDocument();
    for (const [, tag, attributes] of html.matchAll(/<(\w+)\s([^>]*\bid="[^"]+"[^>]*)>/g)) {
        const id = /\bid="([^"]+)"/.exec(attributes!)![1]!;
        const element = new FakeElement(tag!.toLowerCase(), id, document);
        element.hidden = /\shidden\b|^hidden\b/.test(attributes!);
        element.disabled = /\bdisabled\b/.test(attributes!);
        document.byId.set(id, element);
    }
    const scripts = [...html.matchAll(/<script id="([^"]+)">([\s\S]*?)<\/script>/g)].map(([, id, code]) => ({
        id: id!,
        code: code!,
    }));
    for (const { id, code } of scripts) document.byId.get(id)!.textContent = code;

    const blobs = new Map<string, FakeBlob>();
    const networkCalls: string[] = [];
    const windowListeners: Listener[] = [];
    const parentPosts: { message: unknown; targetOrigin: unknown }[] = [];
    const workers: WorkerLike[] = [];
    const blocked = (name: string) =>
        function () {
            networkCalls.push(name);
            throw new Error(`network access: ${name}`);
        };

    const context: Record<string, unknown> = {
        document,
        parent: {
            postMessage(message: { pluginMessage: unknown }, targetOrigin: unknown) {
                parentPosts.push(structuredClone({ message, targetOrigin })); // into this realm
                toMain(structuredClone(message.pluginMessage));
            },
        },
        addEventListener(type: string, listener: Listener) {
            if (type === 'message') windowListeners.push(listener);
        },
        Blob: FakeBlob,
        URL: {
            createObjectURL(blob: FakeBlob) {
                const url = `blob:null/${blobs.size + 1}`;
                blobs.set(url, blob);
                return url;
            },
            revokeObjectURL(url: string) {
                blobs.delete(url);
            },
        },
        TextDecoder,
        TextEncoder,
        // Real timers, but unref'd: the page arms a 10 s revokeObjectURL per download, which must not
        // keep the test file's process alive once every test has passed.
        setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms).unref(),
        clearTimeout,
        console,
        fetch: blocked('fetch'),
        XMLHttpRequest: blocked('XMLHttpRequest'),
        WebSocket: blocked('WebSocket'),
        EventSource: blocked('EventSource'),
        navigator: { sendBeacon: blocked('sendBeacon') },
    };
    if (spawnWorker)
        context.Worker = function (url: string) {
            const blob = blobs.get(url);
            if (!blob) throw new Error(`unknown worker URL ${url}`);
            const worker = spawnWorker(blob.text());
            workers.push(worker);
            return worker;
        };
    context.window = context;
    vm.createContext(context);
    for (const { id, code } of scripts) vm.runInContext(code, context, { filename: `ui.html#${id}` });

    return {
        document,
        context,
        el: (id: string) => document.byId.get(id)!,
        blobs,
        workers,
        networkCalls,
        parentPosts,
        /** The main thread posting `pluginMessage` (what Figma delivers to the iframe). */
        fromMain(pluginMessage: unknown) {
            const event = { data: structuredClone({ pluginMessage }) };
            for (const listener of windowListeners) listener(event);
        },
    };
}
