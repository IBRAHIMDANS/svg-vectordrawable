// Lightweight browser entry (`svg-vectordrawable/browser-lite`): same API as `./browser`, but
// built without svgo (tsup aliases `svgo` to src/svgo-lite.ts, a small XML parser). Roughly 15x
// smaller, at the cost of svgo normalization: conversion always runs with `optimize: false`, so
// inline `<style>` CSS is not applied and shapes / transforms are converted as authored.
// Passing `optimize: true` throws a TypeError rather than silently producing different output.
import { toImageVector as toImageVectorFull } from './compose.js';
import { convert as convertFull } from './convert.js';
import type {
    ConvertOptions as FullConvertOptions,
    ConvertResult,
    ImageVectorOptions as FullImageVectorOptions,
    ImageVectorResult,
} from './types.js';

export { ConversionError } from './errors.js';
export { WARNING_CATEGORIES, WARNING_CODES } from './types.js';
export { vectorDrawableToSvg, UNRESOLVED_COLOR } from './preview.js';
export type {
    ConvertResult,
    Warning,
    WarningCode,
    Severity,
    AndroidColor,
    WarningCategory,
    StrictMode,
    ImageVectorResult,
} from './types.js';
export type { PreviewOptions } from './preview.js';

/** Options of the lite build: no svgo normalization, hence no `svgoConfig` and `optimize` false. */
export type LiteConvertOptions = Omit<FullConvertOptions, 'optimize' | 'svgoConfig'> & {
    /** Always false in the lite build; `true` throws (use `svg-vectordrawable/browser`). */
    optimize?: false;
};
export type { LiteConvertOptions as ConvertOptions };

/** Options of the lite `toImageVector`: same restriction as {@link LiteConvertOptions}. */
export type LiteImageVectorOptions = Omit<FullImageVectorOptions, 'optimize' | 'svgoConfig'> & {
    /** Always false in the lite build; `true` throws (use `svg-vectordrawable/browser`). */
    optimize?: false;
};
export type { LiteImageVectorOptions as ImageVectorOptions };

function rejectOptimize(options: { optimize?: unknown }): void {
    if (options.optimize === true)
        throw new TypeError(
            'optimize: true (svgo normalization) is not available in svg-vectordrawable/browser-lite; ' +
                'use svg-vectordrawable/browser or pass optimize: false.',
        );
}

/** Same as the main `convert`, with `optimize` forced to `false`. */
export function convert(svg: string, options: LiteConvertOptions = {}): ConvertResult {
    rejectOptimize(options);
    return convertFull(svg, { ...options, optimize: false });
}

/** Same as the main `toImageVector`, with `optimize` forced to `false`. */
export function toImageVector(svg: string, options: LiteImageVectorOptions): ImageVectorResult {
    rejectOptimize(options ?? {});
    return toImageVectorFull(svg, { ...options, optimize: false });
}
