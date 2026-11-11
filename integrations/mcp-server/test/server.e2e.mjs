// End-to-end tests: the built server (dist/index.js) spawned over stdio and driven by the SDK client.
// Named *.e2e.mjs so the repository's root vitest run does not collect it. Run: pnpm test.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

const GRADIENT_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g">' +
    '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>' +
    '<path fill="url(#g)" d="M2 2h20v20H2z"/></svg>';
const TEXT_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/><text>hi</text></svg>';

async function startClient(env = {}) {
    const client = new Client({ name: 'svgvd-mcp-test', version: '0.0.0' });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [SERVER],
            env: { ...getDefaultEnvironment(), ...env },
            stderr: 'pipe',
        }),
    );
    return client;
}

/** Asserts a structured tool error and returns its message. */
function toolError(result) {
    assert.equal(result.isError, true, `expected a tool error, got ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(result.content[0].type, 'text');
    return result.content[0].text;
}

describe('svg-vectordrawable MCP server', () => {
    let client;
    before(async () => {
        client = await startClient();
    });
    after(async () => {
        await client.close();
    });

    test('lists convert and preview with their input schemas', async () => {
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        assert.deepEqual(Object.keys(byName).sort(), ['convert', 'preview']);
        assert.deepEqual(Object.keys(byName.convert.inputSchema.properties).sort(), [
            'autoMirrored',
            'colorMap',
            'currentColor',
            'floatPrecision',
            'height',
            'minSdk',
            'rules',
            'strict',
            'svg',
            'tint',
            'width',
        ]);
        assert.deepEqual(byName.convert.inputSchema.required, ['svg']);
        assert.equal(byName.convert.inputSchema.properties.svg.maxLength, MAX_INPUT_BYTES);
        assert.deepEqual(Object.keys(byName.preview.inputSchema.properties).sort(), ['applyTint', 'density', 'xml']);
        assert.ok(byName.convert.outputSchema);
        assert.equal(byName.convert.annotations.readOnlyHint, true);
    });

    test('convert returns xml, categorized warnings and minSdk', async () => {
        const result = await client.callTool({ name: 'convert', arguments: { svg: GRADIENT_SVG, minSdk: 21 } });
        assert.notEqual(result.isError, true);
        const { xml, warnings, minSdk } = result.structuredContent;
        assert.match(xml, /^<vector /);
        assert.match(xml, /aapt:attr/);
        assert.equal(minSdk, 24);
        assert.deepEqual(
            warnings.map((w) => [w.code, w.category]),
            [['min-sdk-exceeded', 'info']],
        );
        assert.match(warnings[0].message, /API 24/);
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    });

    test('convert applies tint, currentColor and floatPrecision', async () => {
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M1.23456 2h20v20H2z"/></svg>';
        const result = await client.callTool({
            name: 'convert',
            arguments: { svg, tint: '?attr/colorControlNormal', currentColor: '#FF5722', floatPrecision: 1 },
        });
        const { xml, warnings } = result.structuredContent;
        assert.match(xml, /android:tint="\?attr\/colorControlNormal"/);
        assert.match(xml, /android:fillColor="#FFFF5722"/);
        assert.match(xml, /M1\.2 /);
        assert.deepEqual(warnings, []);
    });

    test('convert applies autoMirrored, and width alone keeps the aspect ratio', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><path d="M2 2h20v8H2z"/></svg>';
        const result = await client.callTool({ name: 'convert', arguments: { svg, autoMirrored: true, width: 48 } });
        assert.notEqual(result.isError, true);
        const { xml } = result.structuredContent;
        assert.match(xml, /android:autoMirrored="true"/);
        assert.match(xml, /android:width="48dp"/);
        assert.match(xml, /android:height="24dp"/);
        assert.match(xml, /android:viewportWidth="24"/);
        const plain = await client.callTool({ name: 'convert', arguments: { svg, height: 6 } });
        assert.doesNotMatch(plain.structuredContent.xml, /autoMirrored/);
        assert.match(plain.structuredContent.xml, /android:width="12dp"/);
    });

    test('convert maps currentColor and colorMap to theme references', async () => {
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M2 2h9v9H2z"/>' +
            '<path fill="#1a73e8" d="M13 2h9v9h-9z"/></svg>';
        const result = await client.callTool({
            name: 'convert',
            arguments: { svg, currentColor: '?attr/colorControlNormal', colorMap: { '#1A73E8': '@color/brand' } },
        });
        assert.notEqual(result.isError, true);
        const { xml } = result.structuredContent;
        assert.match(xml, /android:fillColor="\?attr\/colorControlNormal"/);
        assert.match(xml, /android:fillColor="@color\/brand"/);
    });

    test('convert reports a lossy warning, and rejects it under strict', async () => {
        const lenient = await client.callTool({ name: 'convert', arguments: { svg: TEXT_SVG } });
        assert.deepEqual(
            lenient.structuredContent.warnings.map((w) => [w.code, w.category]),
            [['unsupported-element', 'lossy']],
        );
        const strict = await client.callTool({ name: 'convert', arguments: { svg: TEXT_SVG, strict: 'lossy' } });
        assert.match(toolError(strict), /\[unsupported-element\]/);
    });

    test('convert applies rules: per-code severity overrides strict', async () => {
        const off = await client.callTool({
            name: 'convert',
            arguments: { svg: TEXT_SVG, strict: 'lossy', rules: { 'unsupported-element': 'off' } },
        });
        assert.notEqual(off.isError, true);
        assert.deepEqual(off.structuredContent.warnings, []);
        const error = await client.callTool({
            name: 'convert',
            arguments: { svg: TEXT_SVG, rules: { 'unsupported-element': 'error' } },
        });
        assert.match(toolError(error), /\[unsupported-element\]/);
    });

    test('preview turns VectorDrawable XML into SVG (round trip)', async () => {
        const converted = await client.callTool({ name: 'convert', arguments: { svg: GRADIENT_SVG } });
        const result = await client.callTool({
            name: 'preview',
            arguments: { xml: converted.structuredContent.xml, density: 2 },
        });
        assert.notEqual(result.isError, true);
        const { svg } = result.structuredContent;
        assert.match(svg, /^<svg /);
        assert.match(svg, /width="48"/);
        assert.match(svg, /linearGradient/);
    });

    test('invalid input is a tool error and the server keeps serving', async () => {
        const cases = [
            ['convert', { svg: 'hello, not an svg' }, /Invalid SVG/],
            ['convert', { svg: '<html></html>' }, /No <svg> root/],
            ['convert', { svg: '' }, /svg/],
            ['convert', {}, /svg/],
            ['convert', { svg: GRADIENT_SVG, floatPrecision: -1 }, /floatPrecision/],
            ['convert', { svg: GRADIENT_SVG, floatPrecision: 1.5 }, /floatPrecision/],
            ['convert', { svg: GRADIENT_SVG, strict: 'yes' }, /strict/],
            ['convert', { svg: GRADIENT_SVG, minSdk: 0 }, /minSdk/],
            ['convert', { svg: GRADIENT_SVG, tint: '"/><evil' }, /tint/],
            ['convert', { svg: GRADIENT_SVG, width: 0 }, /width/],
            ['convert', { svg: GRADIENT_SVG, height: -24 }, /height/],
            ['convert', { svg: GRADIENT_SVG, autoMirrored: 'yes' }, /autoMirrored/],
            ['convert', { svg: GRADIENT_SVG, rules: { 'no-such-code': 'off' } }, /rules/],
            ['convert', { svg: GRADIENT_SVG, rules: { 'unsupported-element': 'fatal' } }, /rules/],
            // Validated by the library: its TypeError is the tool error.
            ['convert', { svg: GRADIENT_SVG, currentColor: '?colorPrimary' }, /Invalid currentColor/],
            ['convert', { svg: GRADIENT_SVG, colorMap: { '#000': '#fff' } }, /Invalid colorMap value/],
            ['convert', { svg: GRADIENT_SVG, colorMap: { nope: '@color/x' } }, /Invalid colorMap key/],
            ['convert', { svg: 'a'.repeat(MAX_INPUT_BYTES + 1) }, /larger than 2 MB/],
            // Under the character bound but over the byte bound (2 bytes per character in UTF-8).
            ['convert', { svg: 'é'.repeat(MAX_INPUT_BYTES / 2 + 1) }, /larger than 2 MB/],
            ['preview', { xml: '<vector/>' }, /viewport/],
            ['preview', { xml: 'not xml' }, /./],
            ['preview', { xml: '<vector/>', density: -1 }, /density/],
        ];
        for (const [name, args, expected] of cases) {
            const message = toolError(await client.callTool({ name, arguments: args }));
            assert.match(message, expected, `${name} ${JSON.stringify(args).slice(0, 80)}`);
        }
        const ok = await client.callTool({ name: 'convert', arguments: { svg: GRADIENT_SVG } });
        assert.notEqual(ok.isError, true);
        assert.match(ok.structuredContent.xml, /^<vector /);
    });

    test('accepts an input right at the size bound', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';
        const padded = svg.replace('<path', `<!--${' '.repeat(MAX_INPUT_BYTES - svg.length - 7)}--><path`);
        assert.equal(Buffer.byteLength(padded), MAX_INPUT_BYTES);
        const result = await client.callTool({ name: 'convert', arguments: { svg: padded } });
        assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 300));
    });
});

describe('time bound', () => {
    test('a call over SVGVD_MCP_TIMEOUT_MS is a tool error, and the server keeps serving', async () => {
        // 1 ms: the worker cannot even start in time, so the timeout path is deterministic.
        const client = await startClient({ SVGVD_MCP_TIMEOUT_MS: '1' });
        try {
            for (let i = 0; i < 2; i++) {
                const result = await client.callTool({ name: 'convert', arguments: { svg: GRADIENT_SVG } });
                assert.match(toolError(result), /convert timed out after 1 ms/);
            }
            const { tools } = await client.listTools();
            assert.equal(tools.length, 2);
        } finally {
            await client.close();
        }
    });
});
