#!/usr/bin/env node
// Step 3/3 of the Android rendering check (see prepare.mjs): compares each Android render
// (build/render/android/<name>.png, written by the Gradle test) with its resvg reference
// (build/render/reference/<name>.png), prints a per-drawable table and exits 1 when
//   - a fixture or probe is at or above the threshold, or
//   - a deliberately broken drawable (kind `broken`) is NOT detected (below 5 %, the bar used by the
//     "harness detects wrong output" cases of test/visual.test.ts).
//
// The metric and thresholds are those of test/visual/compare.ts, imported as-is (Node strips its
// types): premultiplied RGBA, a pixel mismatches when a channel differs by more than 64/255, the
// ratio is over inked pixels, limit 1 %. PNGs store straight alpha, so both sides are premultiplied
// before comparing (±1 rounding, far below the tolerance).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { compareRasters, DEFAULT_MAX_MISMATCH } from '../test/visual/compare.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'build', 'render');
const BROKEN_MIN_MISMATCH = 0.05;

/** Minimal PNG decoder: 8-bit RGB / RGBA, non-interlaced (what resvg and ImageIO write). Returns premultiplied RGBA. */
export function decodePng(buffer) {
    if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    const idat = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            const bitDepth = data[8];
            colorType = data[9];
            if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0) {
                throw new Error(
                    `unsupported PNG (bit depth ${bitDepth}, color type ${colorType}, interlace ${data[12]})`,
                );
            }
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length;
    }
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = inflateSync(Buffer.concat(idat));
    const rows = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const row = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? rows[row + x - bpp] : 0;
            const b = y > 0 ? rows[row - stride + x] : 0;
            const c = x >= bpp && y > 0 ? rows[row - stride + x - bpp] : 0;
            let predictor;
            switch (filter) {
                case 0:
                    predictor = 0;
                    break;
                case 1:
                    predictor = a;
                    break;
                case 2:
                    predictor = b;
                    break;
                case 3:
                    predictor = (a + b) >> 1;
                    break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a);
                    const pb = Math.abs(p - b);
                    const pc = Math.abs(p - c);
                    predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                    break;
                }
                default:
                    throw new Error(`bad PNG filter ${filter}`);
            }
            rows[row + x] = (line[x] + predictor) & 0xff;
        }
    }
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j += bpp) {
        const alpha = bpp === 4 ? rows[j + 3] : 255;
        for (let k = 0; k < 3; k++) pixels[i + k] = Math.round((rows[j + k] * alpha) / 255);
        pixels[i + 3] = alpha;
    }
    return { width, height, pixels };
}

function main() {
    const manifestPath = join(outDir, 'fixtures.tsv');
    if (!existsSync(manifestPath)) {
        console.error(`${manifestPath} missing: run node android-render/prepare.mjs first.`);
        process.exit(1);
    }
    const entries = readFileSync(manifestPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [name, width, height, kind, source, note] = line.split('\t');
            return { name, width: Number(width), height: Number(height), kind, source, note };
        });

    const rows = [];
    let failures = 0;
    for (const entry of entries) {
        const androidPng = join(outDir, 'android', `${entry.name}.png`);
        let status;
        let result = null;
        if (!existsSync(androidPng)) {
            status = 'FAIL (no Android render)';
        } else {
            const reference = decodePng(readFileSync(join(outDir, 'reference', `${entry.name}.png`)));
            result = compareRasters(reference, decodePng(readFileSync(androidPng)));
            if (entry.kind === 'broken') {
                status = result.mismatch > BROKEN_MIN_MISMATCH ? 'ok (detected)' : 'FAIL (not detected)';
            } else if (result.sizeMismatch) {
                status = `FAIL (size ${result.sizeMismatch})`;
            } else if (result.inked === 0) {
                status = 'FAIL (empty)';
            } else {
                status = result.mismatch < DEFAULT_MAX_MISMATCH ? 'ok' : 'FAIL';
            }
        }
        if (status.startsWith('FAIL')) failures++;
        rows.push([
            entry.name,
            entry.kind,
            result ? `${(result.mismatch * 100).toFixed(2)} %` : '-',
            result ? String(result.maxDelta) : '-',
            status,
            entry.note,
        ]);
    }

    const header = ['drawable', 'kind', 'mismatch', 'maxΔ', 'status', 'reference'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const format = (cells) =>
        cells
            .map((c, i) => c.padEnd(widths[i]))
            .join('  ')
            .trimEnd();
    console.log(format(header));
    console.log(format(widths.map((w) => '-'.repeat(w))));
    for (const row of rows) console.log(format(row));
    console.log(
        `\nthreshold: mismatch < ${DEFAULT_MAX_MISMATCH * 100} % of inked pixels (broken cases must exceed ` +
            `${BROKEN_MIN_MISMATCH * 100} %); PNGs in ${outDir}`,
    );
    if (failures > 0) {
        console.error(`${failures} failure(s)`);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
