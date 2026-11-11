// Worker orchestration with a time limit, ported from playground/core.js (createConverter): one
// conversion at a time, a request that does not answer within `timeoutMs` (or that a newer one
// supersedes) terminates its worker, and the next request spawns a fresh one.
//
// Plugin-specific addition: the plugin iframe may refuse to start a `blob:` worker (its CSP is set
// by Figma, not by us). When the very first worker cannot start or dies before answering anything,
// the converter switches for good to `inline`, which converts in the page itself (no time limit).
import { messageOf, type ConversionRequest, type Outcome } from './conversion.ts';

/** Maximum time a conversion may take before its worker is terminated. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** The Web Worker surface used here (what the tests fake). */
export interface WorkerLike {
    postMessage(data: unknown): void;
    terminate(): void;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
}

export interface ConverterConfig {
    createWorker: () => WorkerLike;
    /** In-page conversion, used when workers are unavailable. */
    inline?: (request: ConversionRequest) => Outcome;
    timeoutMs?: number;
}

export interface Converter {
    convert(request: ConversionRequest): Promise<Outcome>;
    /** `worker` until workers turn out to be unavailable, then `inline`. */
    readonly mode: 'worker' | 'inline';
    dispose(): void;
}

interface Pending {
    id: number;
    resolve: (outcome: Outcome) => void;
    timer: ReturnType<typeof setTimeout>;
    request: ConversionRequest;
}

interface WorkerReply {
    id: number;
    outcome: Outcome;
}

const isReply = (data: unknown): data is WorkerReply =>
    typeof data === 'object' && data !== null && typeof (data as WorkerReply).id === 'number';

export function createConverter({ createWorker, inline, timeoutMs = DEFAULT_TIMEOUT_MS }: ConverterConfig): Converter {
    let worker: WorkerLike | null = null;
    let pending: Pending | null = null;
    let nextId = 1;
    let mode: 'worker' | 'inline' = 'worker';
    /** True once a worker has answered: later failures are the input's fault, not the environment's. */
    let workersWork = false;

    function discardWorker(): void {
        if (!worker) return;
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
    }

    function settle(outcome: Outcome): void {
        if (!pending) return;
        const { resolve, timer } = pending;
        clearTimeout(timer);
        pending = null;
        resolve(outcome);
    }

    /** A worker failure: falls back to inline when workers never worked here, else reports it. */
    function fail(message: string): void {
        discardWorker();
        if (pending && inline && !workersWork) {
            mode = 'inline';
            settle(inline(pending.request));
            return;
        }
        settle({ status: 'error', message });
    }

    function ensureWorker(): WorkerLike {
        if (worker) return worker;
        const created = createWorker();
        created.onmessage = (event) => {
            workersWork = true;
            if (pending && isReply(event.data) && event.data.id === pending.id) settle(event.data.outcome);
        };
        created.onerror = (event) => {
            event?.preventDefault?.();
            fail(`The converter could not run (${event?.message || 'worker error'}).`);
        };
        worker = created;
        return created;
    }

    function convert(request: ConversionRequest): Promise<Outcome> {
        if (mode === 'inline' && inline) return Promise.resolve(inline(request));
        if (pending) {
            // The worker is still busy: it cannot be interrupted, only replaced.
            discardWorker();
            settle({ status: 'superseded' });
        }
        return new Promise((resolve) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                discardWorker();
                settle({
                    status: 'timeout',
                    message: `Conversion stopped after ${timeoutMs / 1000} s: this layer is too slow to convert here.`,
                });
            }, timeoutMs);
            pending = { id, resolve, timer, request };
            try {
                ensureWorker().postMessage({ id, ...request });
            } catch (error) {
                // e.g. a SecurityError when the iframe's CSP refuses blob: workers.
                fail(`The converter could not start (${messageOf(error)}).`);
            }
        });
    }

    return {
        convert,
        get mode() {
            return mode;
        },
        dispose() {
            discardWorker();
            settle({ status: 'superseded' });
        },
    };
}
