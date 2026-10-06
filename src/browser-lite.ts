// Lightweight browser entry (`svg-vectordrawable/browser-lite`): same API as `./browser`, but
// built without svgo (tsup aliases `svgo` to src/svgo-lite.ts, a small XML parser). Roughly 15x
// smaller, at the cost of svgo normalization: conversion always runs with `optimize: false`, so
// inline `<style>` CSS is not applied and shapes / transforms are converted as authored.
// Passing `optimize: true` throws a TypeError rather than silently producing different output.
import { convert as convertFull } from './convert.js';
import type { ConvertOptions as FullConvertOptions, ConvertResult } from './types.js';

export { ConversionError } from './errors.js';
export { WARNING_CATEGORIES, WARNING_CODES } from './types.js';
export { vectorDrawableToSvg } from './preview.js';
export type {
    ConvertResult,
    Warning,
    WarningCode,
    Severity,
    AndroidColor,
    WarningCategory,
    StrictMode,
} from './types.js';
export type { PreviewOptions } from './preview.js';

/** Options of the lite build: no svgo normalization, hence no `svgoConfig` and `optimize` false. */
export type LiteConvertOptions = Omit<FullConvertOptions, 'optimize' | 'svgoConfig'> & {
    /** Always false in the lite build; `true` throws (use `svg-vectordrawable/browser`). */
    optimize?: false;
};
export type { LiteConvertOptions as ConvertOptions };

/** Same as the main `convert`, with `optimize` forced to `false`. */
export function convert(svg: string, options: LiteConvertOptions = {}): ConvertResult {
    if ((options as FullConvertOptions).optimize === true)
        throw new TypeError(
            'optimize: true (svgo normalization) is not available in svg-vectordrawable/browser-lite; ' +
                'use svg-vectordrawable/browser or pass optimize: false.',
        );
    return convertFull(svg, { ...options, optimize: false });
}
