import fc from 'fast-check';
import type { Command } from '../src/pathParse.js';

/**
 * fast-check generators of SVG path data, shared by the property suites (T-177). Commands are
 * generated, then written out with the spellings the SVG 2 grammar allows: separators or none,
 * compact arc flags, exponents, `+`, `.5`, `5.`, implicit command letters.
 */

/** Arguments per repetition of each command (mirrors the SVG grammar, not the parser's table). */
export const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
export const ARC_FLAG_INDEXES = new Set([3, 4]);

/** Range of the generated numbers: magnitudes within `max`, and either 0 or at least `min`. */
export interface Range {
    max?: number;
    min?: number;
}

/**
 * A path-data number other than a flag; -0 is folded to 0 (parsing `0` cannot give -0 back). A `min`
 * keeps arc radii away from ~1e-300, whose spec-correct ellipses span beyond 1e21 (TODO.md, « Plus tard »).
 */
export const coordinate = ({ max = 1e6, min = 0 }: Range = {}): fc.Arbitrary<number> =>
    fc
        .oneof(
            fc.integer({ min: -Math.min(max, 100_000), max: Math.min(max, 100_000) }),
            fc.double({ min: -max, max, noNaN: true }),
        )
        .map((v) => (Object.is(v, -0) || Math.abs(v) < min ? 0 : v));

/** One command (any letter, either case) with its arguments; arc flags are 0 or 1. */
export const command = (range: Range = {}): fc.Arbitrary<Command> =>
    fc.tuple(fc.constantFrom(...Object.keys(ARG_COUNT)), fc.boolean()).chain(([upper, lower]) => {
        const cmd = lower ? upper.toLowerCase() : upper;
        const args = Array.from({ length: ARG_COUNT[upper]! }, (_, k) =>
            upper === 'A' && ARC_FLAG_INDEXES.has(k) ? fc.constantFrom(0, 1) : coordinate(range),
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

export const style: fc.Arbitrary<Style> = fc.record({
    spellings: fc.array(fc.constantFrom(...SPELLINGS), { minLength: 64, maxLength: 64 }),
    separators: fc.array(fc.constantFrom('', ' ', ',', ', ', '  ', '\n\t', ' ,'), { minLength: 64, maxLength: 64 }),
    omitLetters: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
});

/** Writes `commands` as path data, varying the spelling as `s` says. */
export function write(commands: Command[], s: Style): string {
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

/** Up to 12 commands and a way to write them; `firstMove` starts the path with M or m. */
export const path = ({ firstMove = false, ...range }: Range & { firstMove?: boolean } = {}): fc.Arbitrary<
    [Command[], Style]
> =>
    fc.tuple(
        fc
            .array(command(range), { minLength: 1, maxLength: 12 })
            .map((cs) => (firstMove && !/^[Mm]$/.test(cs[0]!.cmd) ? [{ cmd: 'M', args: [0, 0] }, ...cs] : cs)),
        style,
    );
