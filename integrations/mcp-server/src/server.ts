import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WARNING_CODES } from 'svg-vectordrawable';
import { z } from 'zod';
import { runIsolated } from './isolate.js';
import type { Job } from './jobs.js';

/** Largest accepted input, in UTF-8 bytes (same bound as the playground). */
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
/** Default wall-clock bound of one tool call; override with `SVGVD_MCP_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS = 10_000;

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const TOO_LARGE = `input is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB (UTF-8)`;

/**
 * A document string bounded in UTF-8 bytes. The character bound is implied by the byte bound; it is
 * kept because it lands in the JSON Schema (`maxLength`) where clients can see it.
 */
const documentInput = (description: string) =>
    z
        .string()
        .min(1)
        .max(MAX_INPUT_BYTES, TOO_LARGE)
        .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_INPUT_BYTES, TOO_LARGE)
        .describe(description);

/** Color literal or resource / theme reference: written verbatim into the XML, so the charset is closed. */
const androidColor = z
    .string()
    .max(128)
    .regex(
        /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[@?][\w:./+-]+)$/,
        'expected #RGB, #ARGB, #RRGGBB, #AARRGGBB, @color/... or ?attr/...',
    );

const convertInput = {
    svg: documentInput('SVG document (markup, not a path or URL)'),
    strict: z
        .union([z.boolean(), z.literal('lossy')])
        .optional()
        .describe(
            'Fail instead of warning: true rejects lossy and approximated output, "lossy" only lossy output. Default false.',
        ),
    rules: z
        .partialRecord(z.enum(WARNING_CODES), z.enum(['off', 'warn', 'error']))
        .optional()
        .describe(
            'Severity per warning code, overriding strict: "off" drops the warning, "warn" reports it, "error" fails. ' +
                'E.g. {"strict": true, "rules": {"opacity-approximated": "warn"}}. The hints "long-path-data" and ' +
                '"invalid-path-data" are off by default: {"invalid-path-data": "warn"} enables one.',
        ),
    // `currentColor` and `colorMap` are validated by the library (its TypeError becomes a tool error):
    // a reference is emitted only when it matches @[package:]color/name or ?[package:]attr/name.
    currentColor: z
        .string()
        .max(128)
        .optional()
        .describe(
            'What currentColor stands for: a CSS color (e.g. "#FF5722", "red"), or an Android color reference ' +
                'emitted as is so the icon follows the theme (?attr/colorControlNormal, @color/brand). Default #000000.',
        ),
    colorMap: z
        .record(z.string().max(64), z.string().max(128))
        .optional()
        .describe(
            'SVG colors to Android color references, e.g. {"#1A73E8": "@color/brand"}. Keys are CSS colors ' +
                '(#f00, red and rgb(255,0,0) are one key); an opaque key also matches its translucent shades.',
        ),
    floatPrecision: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe('Decimal places kept for generated numbers. Default 3.'),
    minSdk: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('The app minSdk: warns (min-sdk-exceeded) when the output needs a higher API level.'),
    tint: androidColor
        .optional()
        .describe('Adds android:tint to the <vector>, e.g. #FFFFFFFF or ?attr/colorControlNormal.'),
    autoMirrored: z
        .boolean()
        .optional()
        .describe('Adds android:autoMirrored="true": flipped in right-to-left layouts (arrows). Default false.'),
    width: z
        .number()
        .positive()
        .optional()
        .describe('android:width in dp, replacing the SVG size. Alone, the height keeps the aspect ratio.'),
    height: z
        .number()
        .positive()
        .optional()
        .describe('android:height in dp, replacing the SVG size. Alone, the width keeps the aspect ratio.'),
};

const convertOutput = {
    xml: z.string().describe('Android VectorDrawable XML (res/drawable/*.xml).'),
    warnings: z
        .array(
            z.object({
                code: z.enum(WARNING_CODES),
                category: z.enum(['lossy', 'approximation', 'info']),
                message: z.string(),
            }),
        )
        .describe(
            'Non-fatal issues: lossy = content dropped, approximation = rendering differs slightly, info = advice.',
        ),
    minSdk: z
        .number()
        .int()
        .describe(
            'Lowest Android API level rendering the output natively: 24 when it uses gradients or android:fillType (evenodd fills), otherwise 21.',
        ),
};

const previewInput = {
    xml: documentInput('Android VectorDrawable XML'),
    density: z
        .number()
        .positive()
        .max(16)
        .optional()
        .describe('Pixels per dp for the SVG width/height (1 = mdpi, 4 = xxxhdpi). Default 1.'),
    applyTint: z.boolean().optional().describe("Apply the vector's android:tint. Default false (tint ignored)."),
};

const previewOutput = {
    svg: z.string().describe('Standalone SVG rendering the same picture.'),
};

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export interface ServerOptions {
    /** Wall-clock bound of one tool call, in milliseconds. */
    timeoutMs?: number;
}

/** Builds the MCP server (transport-agnostic: `index.ts` connects it to stdio). */
export function createServer({ timeoutMs = DEFAULT_TIMEOUT_MS }: ServerOptions = {}): McpServer {
    const server = new McpServer({ name: 'svg-vectordrawable', version });

    const run = async (job: Job): Promise<CallToolResult> => {
        const value = await runIsolated(job, timeoutMs);
        // `text` mirrors `structuredContent` for clients that ignore structured output.
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    };

    server.registerTool(
        'convert',
        {
            title: 'SVG to Android VectorDrawable',
            description:
                'Convert an SVG document to Android VectorDrawable XML. Returns the XML, the warnings (each with a code and ' +
                'a category: lossy, approximation or info) and the minimum Android API level the output needs. ' +
                'Unconvertible input (not an SVG, or a strict-mode violation) returns an error.',
            inputSchema: convertInput,
            outputSchema: convertOutput,
            annotations: READ_ONLY,
        },
        ({ svg, ...options }) => run({ tool: 'convert', svg, options }),
    );

    server.registerTool(
        'preview',
        {
            title: 'VectorDrawable to SVG preview',
            description:
                'Render an Android VectorDrawable XML as a standalone SVG string, to preview a drawable (e.g. the ' +
                'output of convert) in a browser or an image viewer.',
            inputSchema: previewInput,
            outputSchema: previewOutput,
            annotations: READ_ONLY,
        },
        ({ xml, ...options }) => run({ tool: 'preview', xml, options }),
    );

    return server;
}
