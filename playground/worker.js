// Classic Web Worker: converts one SVG per message with the lite browser build (global `svgvd`)
// and renders the result back to SVG for the preview. Runs off the main thread so that a slow
// input can be stopped (core.js terminates this worker on timeout).
importScripts('browser-lite.global.js');

function runConversion(svg, options, preview) {
    let result;
    try {
        result = svgvd.convert(svg, options);
    } catch (error) {
        const warning = error instanceof svgvd.ConversionError ? error.warning : null;
        return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
            code: warning ? warning.code : undefined,
            category: warning ? svgvd.WARNING_CATEGORIES[warning.code] : undefined,
        };
    }
    const outcome = {
        status: 'ok',
        xml: result.xml,
        minSdk: result.minSdk,
        warnings: result.warnings.map((w) => ({
            code: w.code,
            category: svgvd.WARNING_CATEGORIES[w.code],
            message: w.message,
            node: w.node,
        })),
        preview: null,
    };
    try {
        outcome.preview = svgvd.vectorDrawableToSvg(result.xml, preview);
    } catch (error) {
        outcome.previewError = error instanceof Error ? error.message : String(error);
    }
    return outcome;
}

self.onmessage = (event) => {
    const { id, svg, options, preview } = event.data;
    self.postMessage({ id, outcome: runConversion(svg, options, preview) });
};
