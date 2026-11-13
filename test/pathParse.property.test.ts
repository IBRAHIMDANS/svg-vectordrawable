import { createContext, runInContext } from 'node:vm';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fmt } from '../src/pathAbsolute.js';
import { type Command, normalizeArcFlags, parsePath } from '../src/pathParse.js';
import { propertyParams, propertyTimeout } from './property.js';

/**
 * Property-based tests of the path-data parser (T-177, step 1). Commands are generated, written out
 * with the spellings the SVG 2 grammar allows (separators or none, compact arc flags, exponents, `+`,
 * `.5`, `5.`, implicit command letters), and parsed back. The past parser bugs were all such
 * spellings: compact arc flags (TASK-001), exponents (T-10), a number after `Z` (T-08).
 */

/** Arguments per repetition of each command (mirrors the SVG grammar, not the parser's table). */
const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const ARC_FLAG_INDEXES = new Set([3, 4]);

/** A path-data number other than a flag; -0 is folded to 0 (parsing `0` cannot give -0 back). */
const coordinate = fc
    .oneof(fc.integer({ min: -100_000, max: 100_000 }), fc.double({ min: -1e6, max: 1e6, noNaN: true }))
    .map((v) => (Object.is(v, -0) ? 0 : v));

const command: fc.Arbitrary<Command> = fc
    .tuple(fc.constantFrom(...Object.keys(ARG_COUNT)), fc.boolean())
    .chain(([upper, lower]) => {
        const cmd = lower ? upper.toLowerCase() : upper;
        const args = Array.from({ length: ARG_COUNT[upper]! }, (_, k) =>
            upper === 'A' && ARC_FLAG_INDEXES.has(k) ? fc.constantFrom(0, 1) : coordinate,
        );
        return fc.tuple(...args).map((values) => ({ cmd, args: values }));
    });

/** One token of the written path, with what it is (separators depend on it). */
interface Token {
    text: string;
    kind: 'command' | 'number' | 'flag';
}

type Spelling = 'plain' | 'exponent' | 'EXPONENT' | 'plus' | 'leadingDot' | 'trailingDot';
const SPELLINGS: Spelling[] = ['plain', 'exponent', 'EXPONENT', 'plus', 'leadingDot', 'trailingDot'];

/** Writes `v` with one of the spellings of the SVG number grammar; each parses back to exactly `v`. */
function spell(v: number, spelling: Spelling): string {
    const plain = String(v);
    switch (spelling) {
        case 'plain':
            return plain;
        case 'exponent':
            return v.toExponential();
        case 'EXPONENT':
            return v.toExponential().toUpperCase();
        case 'plus':
            return v >= 0 ? `+${plain}` : plain;
        case 'leadingDot':
            return plain.replace(/^(-?)0\./, '$1.');
        case 'trailingDot':
            return Number.isInteger(v) && !/e/i.test(plain) ? `${plain}.` : plain;
    }
}

/** Whether `next` may follow `prev` with no separator and still be read as two tokens. */
function mayTouch(prev: Token, next: Token): boolean {
    if (prev.kind === 'command' || next.kind === 'command') return true;
    // A flag is one character: `1` then `20` is the compact `120` the grammar allows.
    if (prev.kind === 'flag') return true;
    if (next.kind === 'flag') return false;
    if (/^[+-]/.test(next.text)) return true;
    // `1.5` then `.5` is `1.5.5`; `1e5` then `.5` is `1e5.5`.
    return next.text.startsWith('.') && /[.eE]/.test(prev.text);
}

/** Whether `cmd` can be written without its letter after `prev` (implicit repetition). */
function mayOmitLetter(prev: Command | undefined, cmd: Command): boolean {
    if (!prev || prev.cmd === 'Z' || prev.cmd === 'z') return false;
    if (prev.cmd === 'M') return cmd.cmd === 'L';
    if (prev.cmd === 'm') return cmd.cmd === 'l';
    return prev.cmd === cmd.cmd;
}

/** Random choices for writing a path: per token, a spelling, a separator and whether to drop the letter. */
interface Style {
    spellings: Spelling[];
    separators: string[];
    omitLetters: boolean[];
}

const style: fc.Arbitrary<Style> = fc.record({
    spellings: fc.array(fc.constantFrom(...SPELLINGS), { minLength: 64, maxLength: 64 }),
    separators: fc.array(fc.constantFrom('', ' ', ',', ', ', '  ', '\n\t', ' ,'), { minLength: 64, maxLength: 64 }),
    omitLetters: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
});

/** Writes `commands` as path data, varying the spelling as `s` says. */
function write(commands: Command[], s: Style): string {
    const tokens: Token[] = [];
    commands.forEach((c, i) => {
        if (!(s.omitLetters[i % s.omitLetters.length] && mayOmitLetter(commands[i - 1], c))) {
            tokens.push({ text: c.cmd, kind: 'command' });
        }
        c.args.forEach((v, k) => {
            const isFlag = c.cmd.toUpperCase() === 'A' && ARC_FLAG_INDEXES.has(k);
            tokens.push(
                isFlag
                    ? { text: String(v), kind: 'flag' }
                    : { text: spell(v, s.spellings[tokens.length % s.spellings.length]!), kind: 'number' },
            );
        });
    });
    let d = tokens[0]?.text ?? '';
    for (let i = 1; i < tokens.length; i += 1) {
        const [prev, next] = [tokens[i - 1]!, tokens[i]!];
        let sep = s.separators[i % s.separators.length]!;
        if (sep === '' && !mayTouch(prev, next)) sep = ' ';
        // A comma separates two arguments only, never a command letter.
        if (sep.includes(',') && (prev.kind === 'command' || next.kind === 'command')) sep = ' ';
        d += sep + next.text;
    }
    return d;
}

const path = fc.tuple(fc.array(command, { minLength: 1, maxLength: 12 }), style);

describe('parsePath (property)', { timeout: propertyTimeout }, () => {
    it('reads back the generated commands, however the grammar lets them be written', () => {
        fc.assert(
            fc.property(path, ([commands, s]) => {
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
            fc.property(path, ([commands, s]) => {
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
