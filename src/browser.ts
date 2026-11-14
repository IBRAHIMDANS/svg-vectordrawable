// Browser entry: the pure converter and the preview only (no Node fs helpers). svgo resolves to its browser
// bundle via the tsup alias, so this stays free of Node built-ins.
export { convert } from './convert.js';
export { toImageVector, vectorDrawableToImageVector } from './compose.js';
export type { VectorDrawableImageVectorOptions } from './compose.js';
export { ConversionError } from './errors.js';
export { WARNING_CATEGORIES, WARNING_CODES } from './types.js';
export { vectorDrawableToSvg, UNRESOLVED_COLOR } from './preview.js';
export type {
    ConvertOptions,
    ConvertResult,
    Warning,
    WarningCode,
    Severity,
    AndroidColor,
    WarningCategory,
    StrictMode,
    ImageVectorOptions,
    ImageVectorResult,
} from './types.js';
export type { PreviewOptions } from './preview.js';
