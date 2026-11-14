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
     * @param {{ applyTint?: boolean, colors?: Record<string, string> }} [preview] options of vectorDrawableToSvg
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
 * Turns the "Preview colors" field into the `colors` option of `vectorDrawableToSvg`: pairs
 * `reference=color` separated by commas, semicolons or line breaks, e.g.
 * `?attr/colorPrimary=#6750A4, @color/brand=#FF0000`. Spaces around each part are ignored and a later
 * pair overrides an earlier one. Nothing is validated here: a malformed reference or color is
 * passed on, and the preview error the library raises is shown as is.
 */
export function parsePreviewColors(text = '') {
    const colors = {};
    for (const pair of text.split(/[,;\n]/)) {
        if (!pair.trim()) continue;
        const separator = pair.indexOf('=');
        const reference = (separator < 0 ? pair : pair.slice(0, separator)).trim();
        colors[reference] = separator < 0 ? '' : pair.slice(separator + 1).trim();
    }
    return colors;
}

/**
 * The status line of a failed outcome. A `strict` rejection names the warning category that
 * triggered it, e.g. `[unsupported-element] <text> cannot be represented… (lossy, rejected by strict mode)`.
 */
export function describeError({ message, category }) {
    return category ? `${message} (${category}, rejected by strict mode)` : message;
}

/**
 * The note under the previews listing the color references the drawable preview drew in gray, or `''`
 * when every color resolved, e.g. `VectorDrawable result: drawn in gray (no preview value): ?attr/colorPrimary`.
 * It names the drawable preview because the note spans both figures and the source SVG is never gray.
 */
export function describeUnresolvedColors(references = []) {
    return references.length ? `VectorDrawable result: drawn in gray (no preview value): ${references.join(', ')}` : '';
}

/** A `data:` URL for an `<img>` (scripts in an SVG loaded as an image never run). */
export function svgDataUrl(svg) {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Above this length the XML is shown as plain text: one `<span>` per token would slow the page. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

const XML_TOKEN = /(<!--[\s\S]*?-->|<\?[\s\S]*?\?>)|(<\/?[\w:.-]+|\/?>)|("[^"]*")|([\w:.-]+)(?==)/g;
const XML_TOKEN_TYPES = ['comment', 'tag', 'value', 'attr'];

/**
 * Splits VectorDrawable XML into `{ type, text }` tokens for syntax coloring (`comment`, `tag`,
 * `attr`, `value`, or `text` for everything else). Joining the `text` fields gives the input back.
 */
export function tokenizeXml(xml) {
    const tokens = [];
    let end = 0;
    for (const match of xml.matchAll(XML_TOKEN)) {
        if (match.index > end) tokens.push({ type: 'text', text: xml.slice(end, match.index) });
        const group = match.slice(1).findIndex((value) => value !== undefined);
        tokens.push({ type: XML_TOKEN_TYPES[group], text: match[0] });
        end = match.index + match[0].length;
    }
    if (end < xml.length) tokens.push({ type: 'text', text: xml.slice(end) });
    return tokens;
}

const DEFAULT_RESOURCE_NAME = 'ic_drawable';

/** Java reserved keywords and literals, which are not valid `R` field names. */
const JAVA_RESERVED = new Set(
    (
        'abstract assert boolean break byte case catch char class const continue default do double else enum ' +
        'extends false final finally float for goto if implements import instanceof int interface long native ' +
        'new null package private protected public return short static strictfp super switch synchronized this ' +
        'throw throws transient true try void volatile while'
    ).split(' '),
);

/**
 * The name of the downloaded file: an Android resource name (`[a-z][a-z0-9_]*`) derived from the
 * source file name, e.g. `Arrow-Left.svg` → `arrow_left.xml`, `new.svg` → `new_.xml`. A copy of
 * `androidResourceName` (`src/resourceName.ts`), which the lite build does not export; the smoke
 * test checks both stay in sync. Only difference: an empty name falls back to `ic_drawable`, not `ic`.
 */
export function resourceFileName(sourceName = '') {
    const name = sourceName
        .replace(/\.svg$/i, '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!name) return `${DEFAULT_RESOURCE_NAME}.xml`;
    if (/^[0-9]/.test(name)) return `ic_${name}.xml`;
    return JAVA_RESERVED.has(name) ? `${name}_.xml` : `${name}.xml`;
}

/** A human-readable size, e.g. `812 B`, `1.4 kB`, `1.2 MB`. */
export function formatBytes(bytes) {
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The drawable's intrinsic size read from the XML, e.g. `24 × 24 dp`, or `''` when absent. */
export function describeSize(xml) {
    const width = /android:width="([^"]+?)dp"/.exec(xml);
    const height = /android:height="([^"]+?)dp"/.exec(xml);
    return width && height ? `${width[1]} × ${height[1]} dp` : '';
}

/**
 * Install and run commands of the command-line card, per package manager. `dlx` / `bunx` would run
 * it without installing; the card shows the usual setup: a dev dependency, then the project's binary.
 */
export const CLI_SNIPPETS = {
    npm: 'npm install -D svg-vectordrawable\nnpx svgvd icons/ -o app/src/main/res/drawable',
    pnpm: 'pnpm add -D svg-vectordrawable\npnpm exec svgvd icons/ -o app/src/main/res/drawable',
    yarn: 'yarn add -D svg-vectordrawable\nyarn svgvd icons/ -o app/src/main/res/drawable',
    bun: 'bun add -D svg-vectordrawable\nbunx svgvd icons/ -o app/src/main/res/drawable',
};

/**
 * What the API-level card says about a conversion's `minSdk` (the level the drawable needs; 21 is the
 * VectorDrawable floor, 24 means gradients or `fillType`).
 */
export function describeApiLevel(minSdk) {
    if (!minSdk) return 'Convert an SVG to see the API level it needs.';
    if (minSdk <= 21) return `This drawable works from API ${minSdk} (every VectorDrawable device) with android:src.`;
    return `This drawable needs API ${minSdk} with android:src (gradients or fill rules): use app:srcCompat below it.`;
}
