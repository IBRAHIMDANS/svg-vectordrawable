// Web Worker body. The UI starts it from a blob: URL made of the inlined browser-lite bundle
// (which defines the global `svgvd`) followed by this file's build, so nothing is fetched.
import { runConversion, type ConversionRequest, type SvgvdLib } from './conversion.ts';

declare const svgvd: SvgvdLib;

interface WorkerScope {
    onmessage: ((event: { data: { id: number } & ConversionRequest }) => void) | null;
    postMessage(data: unknown): void;
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (event) => {
    const { id, svg, options, preview } = event.data;
    scope.postMessage({ id, outcome: runConversion(svgvd, { svg, options, preview }) });
};
