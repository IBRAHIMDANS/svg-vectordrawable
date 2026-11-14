import { createContext, runInContext } from 'node:vm';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fmt } from '../src/pathAbsolute.js';
import { type Command, normalizeArcFlags, parsePath } from '../src/pathParse.js';
import { ARG_COUNT, path as pathArb, write } from './pathArbitraries.js';
import { propertyParams, propertyTimeout } from './property.js';

/**
 * Property-based tests of the path-data parser (T-177, step 1). Commands are generated, written out
 * with the spellings the SVG 2 grammar allows (separators or none, compact arc flags, exponents, `+`,
 * `.5`, `5.`, implicit command letters), and parsed back. The past parser bugs were all such
 * spellings: compact arc flags (TASK-001), exponents (T-10), a number after `Z` (T-08).
 */

describe('parsePath (property)', { timeout: propertyTimeout }, () => {
    it('reads back the generated commands, however the grammar lets them be written', () => {
        fc.assert(
            fc.property(pathArb(), ([commands, s]) => {
                expect(parsePath(write(commands, s))).toEqual(commands);
            }),
            propertyParams,
        );
    });

    it('always terminates, and every command it returns has its full argument count', () => {
        const alphabet = fc.constantFrom(...'MmLlHhVvCcSsQqTtAaZz0123456789.-+eE ,\n');
        // A vitest timeout cannot stop a synchronous endless loop; vm's timeout can. One context for all draws.
        const sandbox = createContext({ parsePath, d: '' });
        fc.assert(
            fc.property(
                fc.array(alphabet, { maxLength: 40 }).map((chars) => chars.join('')),
                (d) => {
                    sandbox.d = d;
                    const commands = runInContext('parsePath(d)', sandbox, { timeout: 1000 }) as Command[];
                    for (const c of commands) expect(c.args).toHaveLength(ARG_COUNT[c.cmd.toUpperCase()]!);
                },
            ),
            propertyParams,
        );
    });
});

describe('normalizeArcFlags (property)', { timeout: propertyTimeout }, () => {
    it('keeps the parsed commands, separates every arc flag, and is idempotent', () => {
        fc.assert(
            fc.property(pathArb(), ([commands, s]) => {
                const d = write(commands, s);
                const normalized = normalizeArcFlags(d);
                expect(parsePath(normalized)).toEqual(commands);
                expect(normalizeArcFlags(normalized)).toBe(normalized);
                const spans: { start: number; end: number }[] = [];
                parsePath(normalized, spans);
                for (const { start, end } of spans) {
                    expect(start === 0 || /[\s,]/.test(normalized[start - 1]!)).toBe(true);
                    expect(end === normalized.length || /[\s,]/.test(normalized[end]!)).toBe(true);
                }
            }),
            propertyParams,
        );
    });
});

describe('fmt (property)', { timeout: propertyTimeout }, () => {
    // Coordinates up to 1e15: beyond, three decimals exceed double precision; from 1e21 `toFixed` writes an
    // exponent that `fmt` then truncates (`1e+300` → `1e+3`), a known limit kept aside (TODO.md, « Plus tard »).
    const value = fc.double({ min: -1e15, max: 1e15, noNaN: true });

    it('writes a plain decimal: no exponent, at most 3 decimals, no trailing zero, no "-0"', () => {
        fc.assert(
            fc.property(value, (n) => {
                const s = fmt(n);
                expect(s).toMatch(/^-?\d+(\.\d{0,2}[1-9])?$/);
                expect(s).not.toBe('-0');
            }),
            propertyParams,
        );
    });

    it('stays within half a thousandth of the value', () => {
        fc.assert(
            fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (n) => {
                expect(Math.abs(Number(fmt(n)) - n)).toBeLessThanOrEqual(0.0005 + 1e-9);
            }),
            propertyParams,
        );
    });
});
