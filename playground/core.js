// DOM-free logic of the playground: worker orchestration with a timeout, option parsing and
// display helpers. Imported by app.js in the browser and by smoke-test.mjs under Node.

/** Maximum time a conversion may take before its worker is terminated. */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Inputs above this size are rejected before reaching the worker. */
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

/**
 * Runs conversions in a Web Worker, one at a time. A request that does not answer within
 * `timeoutMs` (or that a newer request supersedes) terminates its worker; the next request spawns
 * a fresh one, so a slow input never blocks the page or the following conversions.
 *
 * @param {() => Worker} createWorker factory of workers running worker.js (any object with
 *   `postMessage`, `terminate`, `onmessage` and `onerror` works, which is what the tests use).
 * @param {{ timeoutMs?: number }} [config]
 */
export function createConverter(createWorker, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let worker = null;
    let pending = null;
    let nextId = 1;

    function discardWorker() {
        if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
            worker = null;
        }
    }

    function settle(outcome) {
        if (!pending) return;
        const { resolve, timer } = pending;
        clearTimeout(timer);
        pending = null;
        resolve(outcome);
    }

    function ensureWorker() {
        if (worker) return worker;
        worker = createWorker();
        worker.onmessage = (event) => {
            const data = event.data;
            if (pending && data && data.id === pending.id) settle(data.outcome);
        };
        worker.onerror = (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            discardWorker();
            settle({
                status: 'error',
                message: `The converter could not run (${(event && event.message) || 'worker error'}).`,
            });
        };
        return worker;
    }

    /**
     * @param {string} svg
     * @param {object} options ConvertOptions of the lite build
     * @param {{ applyTint?: boolean }} [preview] options of vectorDrawableToSvg
     * @returns {Promise<object>} an outcome: `ok`, `error`, `timeout` or `superseded`
     */
    function convert(svg, options, preview = {}) {
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
                    message: `Conversion stopped after ${timeoutMs / 1000} s: this SVG is too slow to convert here.`,
                });
            }, timeoutMs);
            pending = { id, resolve, timer };
            try {
                ensureWorker().postMessage({ id, svg, options, preview });
            } catch (error) {
                // e.g. a SecurityError when the page is opened from file:// instead of over HTTP.
                discardWorker();
                settle({ status: 'error', message: `The converter could not start (${error.message}).` });
            }
        });
    }

    /** Stops the current worker, if any (a pending request resolves as `superseded`). */
    function dispose() {
        discardWorker();
        settle({ status: 'superseded' });
    }

    return { convert, dispose };
}

/**
 * Turns the raw form values (strings) into ConvertOptions, leaving out what is unset. Numbers are
 * not range-checked here: the converter validates them and its error message is shown as is.
 */
export function buildOptions({ strict = 'off', currentColor = '', floatPrecision = '', minSdk = '', tint = '' } = {}) {
    const options = {};
    if (strict === 'all') options.strict = true;
    else if (strict === 'lossy') options.strict = 'lossy';
    if (currentColor.trim()) options.currentColor = currentColor.trim();
    if (floatPrecision.trim()) options.floatPrecision = Number(floatPrecision);
    if (minSdk.trim()) options.minSdk = Number(minSdk);
    if (tint.trim()) options.tint = tint.trim();
    return options;
}

/**
 * The status line of a failed outcome. A `strict` rejection names the warning category that
 * triggered it, e.g. `[unsupported-element] <text> cannot be represented… (lossy, rejected by strict mode)`.
 */
export function describeError({ message, category }) {
    return category ? `${message} (${category}, rejected by strict mode)` : message;
}

/**
 * The note under the drawable preview listing the color references it drew in gray, or `''` when
 * every color resolved, e.g. `Drawn in gray (no preview value): ?attr/colorPrimary`.
 */
export function describeUnresolvedColors(references = []) {
    return references.length ? `Drawn in gray (no preview value): ${references.join(', ')}` : '';
}

/** A `data:` URL for an `<img>` (scripts in an SVG loaded as an image never run). */
export function svgDataUrl(svg) {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
