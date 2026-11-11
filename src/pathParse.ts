/** SVG path-data parsing: the `d` attribute string into commands, and arc-flag normalization. */

/** One parsed path command: the (uppercase, absolute-or-relative) letter plus its raw numbers. */
export interface Command {
    /** Command letter as written, e.g. 'M', 'm', 'c', 'A'. Case encodes absolute vs relative. */
    cmd: string;
    /** Flat list of numeric arguments exactly as parsed. */
    args: number[];
}

/** Number of arguments each command consumes per repetition. Z/z take none. */
const ARG_COUNT: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    A: 7,
    Z: 0,
};

/** Positions of the large-arc and sweep flags inside one A/a argument group. */
const ARC_FLAG_INDEXES = new Set([3, 4]);

/** A full path-data number token (same grammar as the tokenizer's number branch). */
const NUMBER_TOKEN_RE = /^-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?$/;

/**
 * Splits a compact arc-flag token. SVG flags are single characters (`0`/`1`) and need no separator,
 * so `0120` means flag 0, then `120` (itself flag 1 then `20`), and `01` means flags 0 and 1.
 * Returns null when the token is a single character or does not start with a flag followed by a
 * valid number, in which case the caller keeps the token as a plain number.
 */
function splitArcFlag(token: string): { flag: number; rest: string } | null {
    if (token.length < 2 || (token[0] !== '0' && token[0] !== '1')) return null;
    const rest = token.slice(1);
    if (!NUMBER_TOKEN_RE.test(rest)) return null;
    return { flag: Number(token[0]), rest };
}

/** Source span `[start, end)` of one arc flag inside the original path-data string. */
interface FlagSpan {
    start: number;
    end: number;
}

/**
 * Tokenizes a path-data string into commands, splitting repeated argument groups into separate
 * commands (e.g. `M0 0 1 1` → an M then an implicit L, per the SVG spec). Returns [] on garbage.
 * When `flagSpans` is given, the source span of every arc flag of a complete A/a group is appended.
 */
export function parsePath(d: string, flagSpans?: FlagSpan[]): Command[] {
    const commands: Command[] = [];
    // Match a command letter or a number (incl. scientific notation, leading sign, dot).
    const tokenRe = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
    const tokens: string[] = [];
    // Source offset of each token, kept in sync when a compact arc flag is split off.
    const offsets: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(d)) !== null) {
        tokens.push(match[1] ?? match[2]!);
        offsets.push(match.index);
    }

    let i = 0;
    let prevCmd = '';
    while (i < tokens.length) {
        const tok = tokens[i]!;
        let cmd: string;
        if (/[a-zA-Z]/.test(tok)) {
            cmd = tok;
            i += 1;
        } else {
            // Bare number with no leading letter: only valid if a previous command can repeat.
            if (!prevCmd) break;
            // After an explicit moveto, subsequent coordinate pairs are implicit linetos.
            cmd = prevCmd === 'M' ? 'L' : prevCmd === 'm' ? 'l' : prevCmd;
        }

        const upper = cmd.toUpperCase();
        const count = ARG_COUNT[upper];
        if (count === undefined) break; // unknown command letter → bail out

        if (count === 0) {
            commands.push({ cmd, args: [] });
            prevCmd = cmd;
            continue;
        }

        // Consume `count` numbers; stop if the path ends mid-group (malformed).
        const args: number[] = [];
        const spans: FlagSpan[] = [];
        for (let k = 0; k < count; k += 1) {
            const next = tokens[i];
            if (next === undefined || /[a-zA-Z]/.test(next)) break;
            if (upper === 'A' && ARC_FLAG_INDEXES.has(k)) {
                const split = splitArcFlag(next);
                if (split) {
                    args.push(split.flag);
                    spans.push({ start: offsets[i]!, end: offsets[i]! + 1 });
                    // The rest of the token is re-read as the next argument(s).
                    tokens[i] = split.rest;
                    offsets[i] = offsets[i]! + 1;
                    continue;
                }
                spans.push({ start: offsets[i]!, end: offsets[i]! + next.length });
            }
            args.push(Number(next));
            i += 1;
        }
        if (args.length < count) break; // incomplete final command
        commands.push({ cmd, args });
        flagSpans?.push(...spans);
        prevCmd = cmd;
    }

    return commands;
}

/** Characters that already separate two path-data arguments. */
const SEPARATOR_RE = /[\s,]/;

/**
 * Rewrites only the large-arc and sweep flags of A/a commands so each is separated from its
 * neighbours (e.g. `a10 10 0 0120 0` → `a10 10 0 0 1 20 0`). SVG allows compact flags without
 * separators, but some Android API levels' PathParser misread them as one number. A single space is
 * inserted only where a flag touches another token; every other character is kept, so a path
 * without arcs (or with already separated flags) is returned unchanged.
 */
export function normalizeArcFlags(d: string): string {
    const spans: FlagSpan[] = [];
    parsePath(d, spans);
    const cuts = new Set<number>();
    for (const { start, end } of spans) {
        if (start > 0 && !SEPARATOR_RE.test(d[start - 1]!)) cuts.add(start);
        if (end < d.length && !SEPARATOR_RE.test(d[end]!)) cuts.add(end);
    }
    if (cuts.size === 0) return d;
    let out = '';
    let last = 0;
    for (const cut of [...cuts].sort((a, b) => a - b)) {
        out += `${d.slice(last, cut)} `;
        last = cut;
    }
    return out + d.slice(last);
}
