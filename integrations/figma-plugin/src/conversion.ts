// One conversion, as the worker (or the in-page fallback) runs it with the lite browser build:
// SVG -> VectorDrawable XML + warnings (code and category) + an SVG preview of the result.
// The outcome is plain data, so it crosses postMessage unchanged.
import type * as Svgvd from '../../../src/browser-lite.ts';

/** The part of the `svgvd` global (dist/browser-lite.global.js) the plugin uses. */
export type SvgvdLib = Pick<
    typeof Svgvd,
    'convert' | 'vectorDrawableToSvg' | 'ConversionError' | 'WARNING_CATEGORIES' | 'WARNING_CODES'
>;
export type ConvertOptions = Svgvd.ConvertOptions;
export type PreviewOptions = Svgvd.PreviewOptions;

export interface OutcomeWarning {
    code: string;
    /** `lossy`, `approximation` or `info` (WARNING_CATEGORIES). */
    category: string | undefined;
    message: string;
    node?: string;
}

export type Outcome =
    | {
          status: 'ok';
          xml: string;
          minSdk: number;
          warnings: OutcomeWarning[];
          /** The drawable rendered back to SVG, or null when that failed (see previewError). */
          preview: string | null;
          previewError?: string;
      }
    | { status: 'error'; message: string; code?: string; category?: string }
    | { status: 'timeout'; message: string }
    | { status: 'superseded' };

export interface ConversionRequest {
    svg: string;
    options?: ConvertOptions;
    preview?: PreviewOptions;
}

/** The message of a thrown value; duck-typed, since the bundle may live in another realm. */
export const messageOf = (error: unknown): string =>
    typeof error === 'object' && error !== null && typeof (error as Error).message === 'string'
        ? (error as Error).message
        : String(error);

/** Converts one SVG; never throws (a failure is an `error` outcome). */
export function runConversion(lib: SvgvdLib, { svg, options = {}, preview = {} }: ConversionRequest): Outcome {
    let result: ReturnType<SvgvdLib['convert']>;
    try {
        result = lib.convert(svg, options);
    } catch (error) {
        const warning = error instanceof lib.ConversionError ? error.warning : undefined;
        return {
            status: 'error',
            message: messageOf(error),
            ...(warning ? { code: warning.code, category: lib.WARNING_CATEGORIES[warning.code] } : {}),
        };
    }
    const outcome: Outcome = {
        status: 'ok',
        xml: result.xml,
        minSdk: result.minSdk,
        warnings: result.warnings.map((w) => ({
            code: w.code,
            category: lib.WARNING_CATEGORIES[w.code],
            message: w.message,
            ...(w.node === undefined ? {} : { node: w.node }),
        })),
        preview: null,
    };
    try {
        outcome.preview = lib.vectorDrawableToSvg(result.xml, preview);
    } catch (error) {
        outcome.previewError = messageOf(error);
    }
    return outcome;
}

/**
 * The status line of a failed outcome. A `strict` rejection names the warning category that
 * triggered it (same wording as the playground).
 */
export function describeError(outcome: { message: string; category?: string }): string {
    return outcome.category ? `${outcome.message} (${outcome.category}, rejected by strict mode)` : outcome.message;
}

/** A `data:` URL for an `<img>`: scripts in an SVG loaded as an image never run. */
export function svgDataUrl(svg: string): string {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
