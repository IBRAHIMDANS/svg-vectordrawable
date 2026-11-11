import { Worker } from 'node:worker_threads';
import type { ConvertOutput, Job, PreviewOutput } from './jobs.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

type WorkerReply = { ok: true; value: ConvertOutput | PreviewOutput } | { ok: false; error: string };

/**
 * Runs a job in a fresh worker thread, killed after `timeoutMs`. Conversion is synchronous CPU work:
 * on the main thread a pathological SVG would block the stdio loop and every later request. One
 * worker per call keeps it simple (no pool, no state shared between calls). Rejects with an `Error`
 * whose message is meant for the MCP client.
 */
export function runIsolated(job: Job, timeoutMs: number): Promise<ConvertOutput | PreviewOutput> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_URL, { workerData: job });
        let settled = false;
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            fn();
        };
        const timer = setTimeout(
            () => settle(() => reject(new Error(`${job.tool} timed out after ${timeoutMs} ms`))),
            timeoutMs,
        );
        worker.once('message', (reply: WorkerReply) =>
            settle(() => (reply.ok ? resolve(reply.value) : reject(new Error(reply.error)))),
        );
        worker.once('error', (error) => settle(() => reject(error)));
        worker.once('exit', (code) => settle(() => reject(new Error(`${job.tool} worker exited with code ${code}`))));
    });
}
