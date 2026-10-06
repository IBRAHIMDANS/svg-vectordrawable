export { convert } from './convert.js';
export { ConversionError } from './errors.js';
export { WARNING_CATEGORIES, WARNING_CODES } from './types.js';
export { convertFile, convertDir } from './file.js';
export { androidResourceName } from './resourceName.js';
export { vectorDrawableToSvg } from './preview.js';
export type {
    ConvertOptions,
    ConvertResult,
    Warning,
    WarningCode,
    WarningCategory,
    Severity,
    StrictMode,
    AndroidColor,
} from './types.js';
export type { ConvertDirResult, FileNamingOptions } from './file.js';
export type { PreviewOptions } from './preview.js';
