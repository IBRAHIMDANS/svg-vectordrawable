// "Works without network": the manifest asks for no network access, and the built plugin neither
// references an external resource nor calls a network API (the behaviour itself is exercised with
// throwing network globals in ui-test.ts and conversion-test.ts).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { here } from './helpers.ts';

const manifest = JSON.parse(readFileSync(here('../manifest.json'), 'utf8'));
const built = (path: string): string => {
    const file = here(`../${path}`);
    assert.ok(existsSync(file), `${path} is missing: run \`node scripts/build.ts\``);
    return readFileSync(file, 'utf8');
};

test('the manifest declares no network access and points to the built files', () => {
    assert.deepEqual(manifest.networkAccess, { allowedDomains: ['none'] });
    assert.equal(manifest.main, 'dist/code.js');
    assert.equal(manifest.ui, 'dist/ui.html');
    assert.deepEqual(manifest.editorType, ['figma']);
    assert.equal(manifest.documentAccess, 'dynamic-page');
    assert.equal(manifest.api, '1.0.0');
});

test('ui.html is self-contained: no external script, stylesheet, font, image or frame', () => {
    const html = built('dist/ui.html');
    assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /<(?:iframe|img|object|embed|video|audio|source)\b/i, 'no static media element');
    assert.doesNotMatch(html, /@import|url\(\s*['"]?(?:https?:)?\/\//i);
    // The only URLs are XML namespace names (strings, never fetched); XHTML and MathML are the
    // `requiredExtensions` the library recognizes (src/elements.ts), XLink the namespace whose
    // aliases (`xl:href`) prepareSource renames (src/normalize.ts).
    const urls = new Set(html.match(/https?:\/\/[^\s"'`<>)\\]+/g));
    assert.deepEqual([...urls].sort(), [
        'http://schemas.android.com/aapt',
        'http://schemas.android.com/apk/res/android',
        'http://www.w3.org/1998/Math/MathML',
        'http://www.w3.org/1999/xhtml',
        'http://www.w3.org/1999/xlink',
        'http://www.w3.org/2000/svg',
    ]);
    // Both scripts are inlined: the lite bundle (global svgvd) and the UI.
    assert.match(html, /<script id="svgvd-bundle">\s*"use strict";var svgvd=/);
    assert.match(html, /<script id="ui-script">\s*"use strict";/);
});

test('no network API is called by the main thread, the UI or the worker', () => {
    for (const path of ['dist/code.js', 'dist/ui.html']) {
        const source = built(path);
        assert.doesNotMatch(
            source,
            /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|figma\.\w*(?:fetch|http)/i,
            path,
        );
    }
});
