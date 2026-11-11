import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { crc32, createZip } from '../src/zip.ts';
import { readZip } from './helpers.ts';

test('crc32 matches node:zlib', () => {
    for (const text of ['', 'a', 'The quick brown fox jumps over the lazy dog', '<vector>é</vector>\n']) {
        const data = new TextEncoder().encode(text);
        assert.equal(crc32(data), zlib.crc32(data), text);
    }
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a stored archive reads back with the same paths and bytes', () => {
    const files = { 'drawable/ic_a.xml': '<vector a/>\n', 'drawable/ic_b.xml': '<vector b="é"/>\n', 'empty.txt': '' };
    const zip = createZip(Object.entries(files).map(([path, data]) => ({ path, data })));
    const read = readZip(zip, (data) => zlib.crc32(data));
    assert.deepEqual([...read.keys()], Object.keys(files));
    for (const [path, text] of Object.entries(files)) assert.equal(new TextDecoder().decode(read.get(path)), text);
});

test('the DOS timestamp is the given date (2 s resolution)', () => {
    const zip = createZip([{ path: 'a', data: 'x' }], new Date(2026, 10, 11, 9, 30, 15));
    const view = new DataView(zip.buffer);
    assert.equal(view.getUint16(10, true), (9 << 11) | (30 << 5) | 7);
    assert.equal(view.getUint16(12, true), ((2026 - 1980) << 9) | (11 << 5) | 11);
});

test('duplicate or unsafe paths are refused', () => {
    assert.throws(
        () =>
            createZip([
                { path: 'a.xml', data: '' },
                { path: 'a.xml', data: '' },
            ]),
        /Duplicate path/,
    );
    for (const path of ['', '/abs.xml', '../up.xml', 'drawable/../../x.xml'])
        assert.throws(() => createZip([{ path, data: '' }]), /Invalid path/, path);
});

test('an empty archive is a valid end-of-central-directory record', () => {
    const zip = createZip([]);
    assert.equal(zip.byteLength, 22);
    assert.equal(readZip(zip, zlib.crc32).size, 0);
});

test('`unzip -t` accepts the archive (skipped when unzip is not installed)', (t) => {
    try {
        execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
        t.skip('unzip not available');
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'figma-zip-'));
    try {
        const file = join(dir, 'drawables.zip');
        writeFileSync(file, createZip([{ path: 'drawable/ic_a.xml', data: '<vector/>\n' }]));
        assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
