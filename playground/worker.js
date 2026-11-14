// Classic Web Worker: converts one input per message with the lite browser build (global `svgvd`)
// and renders the result back to SVG for the preview. Runs off the main thread so that a slow
// input can be stopped (core.js terminates this worker on timeout).
//
// The input is an SVG, or an existing Android VectorDrawable (its root element is <vector>). The
// requested format is what the output pane shows: `vector` (VectorDrawable XML, SVG input only),
// `compose` (a Kotlin ImageVector, both inputs) or `svg` (VectorDrawable input only).
importScripts('browser-lite.global.js');

/** Same test as the CLI: a document whose root element is <vector>, after a prolog and comments. */
const VECTOR_ROOT = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<vector[\s>]/;

const reported = (warnings) =>
    warnings.map((w) => ({
        code: w.code,
        category: svgvd.WARNING_CATEGORIES[w.code],
        message: w.message,
        node: w.node,
    }));

/** Renders a VectorDrawable for a preview; the references the preview has no value for are listed. */
function previewOf(xml, preview) {
    // The callback cannot cross postMessage: collect the references here and send them as data.
    const unresolvedColors = [];
    try {
        const svg = svgvd.vectorDrawableToSvg(xml, {
            ...preview,
            onUnresolvedColor: (reference) => unresolvedColors.push(reference),
        });
        return { preview: svg, unresolvedColors };
    } catch (error) {
        return {
            preview: null,
            unresolvedColors: [],
            previewError: error instanceof Error ? error.message : String(error),
        };
    }
}

function fromSvg(svg, options, preview, format, name) {
    const result = svgvd.convert(svg, options);
    let output = result.xml;
    let warnings = result.warnings;
    let kotlinName;
    if (format === 'compose') {
        // Same conversion, serialized as Kotlin: its warnings include those of `convert`.
        const kotlin = svgvd.toImageVector(svg, { ...options, name });
        output = kotlin.kotlin;
        warnings = kotlin.warnings;
        kotlinName = kotlin.name;
    }
    return {
        status: 'ok',
        input: 'svg',
        format: format === 'compose' ? 'compose' : 'vector',
        output,
        xml: result.xml,
        kotlinName,
        minSdk: result.minSdk,
        warnings: reported(warnings),
        sourcePreview: null,
        ...previewOf(result.xml, preview),
    };
}

function fromVectorDrawable(xml, options, preview, format, name) {
    const rendered = previewOf(xml, preview);
    if (rendered.previewError) throw new Error(rendered.previewError);
    if (format === 'compose') {
        // Serialized as is: only the warning policy of the options applies.
        const kotlin = svgvd.vectorDrawableToImageVector(xml, { name, strict: options.strict, rules: options.rules });
        return {
            status: 'ok',
            input: 'vectordrawable',
            format: 'compose',
            output: kotlin.kotlin,
            kotlinName: kotlin.name,
            minSdk: null,
            warnings: reported(kotlin.warnings),
            sourcePreview: rendered.preview,
            ...rendered,
        };
    }
    return {
        status: 'ok',
        input: 'vectordrawable',
        format: 'svg',
        output: rendered.preview,
        minSdk: null,
        warnings: [],
        sourcePreview: rendered.preview,
        ...rendered,
    };
}

function runConversion(source, options, preview, format = 'vector', name = 'Icon') {
    try {
        return VECTOR_ROOT.test(source)
            ? fromVectorDrawable(source, options, preview, format, name)
            : fromSvg(source, options, preview, format, name);
    } catch (error) {
        const warning = error instanceof svgvd.ConversionError ? error.warning : null;
        return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
            code: warning ? warning.code : undefined,
            category: warning ? svgvd.WARNING_CATEGORIES[warning.code] : undefined,
        };
    }
}

self.onmessage = (event) => {
    const { id, svg, options, preview, format, name } = event.data;
    self.postMessage({ id, outcome: runConversion(svg, options, preview, format, name) });
};
