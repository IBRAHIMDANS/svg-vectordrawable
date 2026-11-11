export { convert } from './convert.js';
export { toImageVector } from './compose.js';
export { ConversionError } from './errors.js';
export { WARNING_CATEGORIES, WARNING_CODES } from './types.js';
export { convertFile, convertDir } from './file.js';
export { androidResourceName } from './resourceName.js';
export { vectorDrawableToSvg, UNRESOLVED_COLOR } from './preview.js';
export { renderFallbackPng, DENSITIES } from './fallback.js';
export type {
    ConvertOptions,
    ConvertResult,
    Warning,
    WarningCode,
    WarningCategory,
    Severity,
    StrictMode,
    AndroidColor,
    ImageVectorOptions,
    ImageVectorResult,
} from './types.js';
export type { ConvertDirResult, FileNamingOptions } from './file.js';
export type { PreviewOptions } from './preview.js';
export type { Density, FallbackPngOptions } from './fallback.js';
