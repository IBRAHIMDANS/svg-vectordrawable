// Worker thread entry: runs one job and posts the outcome back. Errors are serialized to a message,
// so a throwing conversion never reaches the server's event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { type Job, runJob } from './jobs.js';

try {
    parentPort!.postMessage({ ok: true, value: runJob(workerData as Job) });
} catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
