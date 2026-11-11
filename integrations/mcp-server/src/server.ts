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
    currentColor: z
        .string()
        .max(64)
        .optional()
        .describe('CSS color substituted for currentColor (e.g. "#FF5722", "red"). Default #000000.'),
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
        .describe('Lowest Android API level rendering the output natively (21, or 24 with gradients).'),
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
