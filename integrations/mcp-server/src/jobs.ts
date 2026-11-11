import { WARNING_CATEGORIES, convert, vectorDrawableToSvg } from 'svg-vectordrawable';
import type { ConvertOptions, PreviewOptions, WarningCategory, WarningCode } from 'svg-vectordrawable';

/** The `convert` options exposed by the MCP tool (the subset of `ConvertOptions` a chat client needs). */
export type ConvertToolOptions = Pick<
    ConvertOptions,
    | 'strict'
    | 'rules'
    | 'currentColor'
    | 'colorMap'
    | 'floatPrecision'
    | 'minSdk'
    | 'tint'
    | 'autoMirrored'
    | 'width'
    | 'height'
>;

export interface ConvertOutput {
    [key: string]: unknown;
    xml: string;
    warnings: { code: WarningCode; category: WarningCategory; message: string }[];
    minSdk: number;
}

export interface PreviewOutput {
    [key: string]: unknown;
    svg: string;
}

/** A unit of work run off the main thread (see `isolate.ts`). Plain data: it crosses a worker boundary. */
export type Job =
    | { tool: 'convert'; svg: string; options: ConvertToolOptions }
    | { tool: 'preview'; xml: string; options: PreviewOptions };

/** Runs a job synchronously. Throws the library's error (e.g. `ConversionError` under `strict`). */
export function runJob(job: Job): ConvertOutput | PreviewOutput {
    if (job.tool === 'preview') return { svg: vectorDrawableToSvg(job.xml, job.options) };
    const { xml, warnings, minSdk } = convert(job.svg, job.options);
    return {
        xml,
        warnings: warnings.map(({ code, message }) => ({ code, category: WARNING_CATEGORIES[code], message })),
        minSdk,
    };
}
