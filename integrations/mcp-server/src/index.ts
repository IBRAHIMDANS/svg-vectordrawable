#!/usr/bin/env node
// stdio entry point. stdout carries the MCP protocol: diagnostics go to stderr only.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_TIMEOUT_MS, createServer } from './server.js';

function readTimeout(): number {
    const raw = process.env.SVGVD_MCP_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
    const ms = Number(raw);
    if (!Number.isInteger(ms) || ms <= 0) {
        console.error(`svg-vectordrawable-mcp: invalid SVGVD_MCP_TIMEOUT_MS=${raw} (expected a positive integer)`);
        process.exit(1);
    }
    return ms;
}

await createServer({ timeoutMs: readTimeout() }).connect(new StdioServerTransport());
