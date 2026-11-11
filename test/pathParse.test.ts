import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { normalizeArcFlags, parsePath } from '../src/pathParse.js';

/**
 * Runs `parsePath(d)` with a hard time limit. A vitest timeout cannot interrupt a synchronous
 * endless loop; `vm`'s `timeout` terminates the running script (host functions it calls included).
 */
function parseWithin(d: string, ms = 1000): ReturnType<typeof parsePath> {
    return runInNewContext('parsePath(d)', { parsePath, d }, { timeout: ms }) as ReturnType<typeof parsePath>;
}

/** Argument lists only, for compact assertions. */
const argsOf = (d: string): number[][] => parsePath(d).map((c) => c.args);

describe('parsePath: numbers after a command that cannot repeat (T-08)', () => {
    it('stops on a number after Z instead of looping forever', () => {
        expect(parseWithin('M0 0 L5 5 Z 10 10')).toEqual([
            { cmd: 'M', args: [0, 0] },
            { cmd: 'L', args: [5, 5] },
            { cmd: 'Z', args: [] },
        ]);
    });

    it('stops on a number after a lowercase z, and keeps nothing after it', () => {
        expect(parseWithin('m0 0l5 5z1 1L9 9').map((c) => c.cmd)).toEqual(['m', 'l', 'z']);
    });

    it('still parses a command letter that follows Z', () => {
        expect(parseWithin('M0 0L5 5ZM1 1L2 2z').map((c) => c.cmd)).toEqual(['M', 'L', 'Z', 'M', 'L', 'z']);
    });

    it('returns [] on a number with no leading command', () => {
        expect(parseWithin('10 10 L5 5')).toEqual([]);
    });
});

describe('parsePath: SVG 2 number grammar (T-10)', () => {
    it('reads a negative exponent instead of taking its `e` for a command', () => {
        expect(parsePath('M0 0L1e-170 0')).toEqual([
            { cmd: 'M', args: [0, 0] },
            { cmd: 'L', args: [1e-170, 0] },
        ]);
    });

    it('reads positive, signed and uppercase exponents', () => {
        expect(argsOf('M2e1 2E1L1e+2 -3.5E-1l.5e1 1.e1')).toEqual([
            [20, 20],
            [100, -0.35],
            [5, 10],
        ]);
    });

    it('reads an exponent in every argument position of every command', () => {
        const d =
            'M1e1 1e1H2e1V2e1C1e1 1e1 2e1 2e1 3e1 3e1S1e1 1e1 2e1 2e1Q1e1 1e1 2e1 2e1T3e1 3e1A1e1 1e1 0 0 1 2e1 2e1Z';
        expect(parsePath(d).map((c) => c.cmd)).toEqual(['M', 'H', 'V', 'C', 'S', 'Q', 'T', 'A', 'Z']);
        expect(parsePath(d).at(-2)!.args).toEqual([10, 10, 0, 0, 1, 20, 20]);
    });

    it('splits `1.5.5` into 1.5 and .5, and `1-2` into 1 and -2', () => {
        expect(argsOf('M1.5.5L1-2')).toEqual([
            [1.5, 0.5],
            [1, -2],
        ]);
    });

    it('accepts a leading `+` sign', () => {
        expect(argsOf('M+1+2L+.5,-.5')).toEqual([
            [1, 2],
            [0.5, -0.5],
        ]);
    });

    it('keeps an `e` without exponent digits out of the number (`1e` is 1 then garbage)', () => {
        expect(argsOf('M1e 2')).toEqual([[1, 2]]);
    });

    it('still splits compact arc flags next to an exponent', () => {
        expect(parsePath('M0 0a1e1 1e1 0 012e1 0')[1]!.args).toEqual([10, 10, 0, 0, 1, 20, 0]);
        expect(normalizeArcFlags('M0 0a1e1 1e1 0 012e1 0')).toBe('M0 0a1e1 1e1 0 0 1 2e1 0');
    });
});
