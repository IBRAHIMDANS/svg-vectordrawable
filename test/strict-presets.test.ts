import { describe, expect, it } from 'vitest';
import {
    convert,
    ConversionError,
    WARNING_CATEGORIES,
    WARNING_CODES,
    type StrictMode,
    type WarningCategory,
} from '../src/index.js';

const svg = (body: string, attrs = 'viewBox="0 0 24 24"'): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

/** `lossy`: a dash pattern in `em` cannot be resolved; the stroke is drawn solid. */
const LOSSY = svg('<path d="M0 0L24 24" stroke="#000" stroke-dasharray="1em"/>');
/** `approximation`: group opacity folded onto overlapping children. */
const APPROX = svg('<g opacity="0.5"><rect width="12" height="12"/><rect x="6" y="6" width="12" height="12"/></g>');
/** `info`: a 512dp vector. */
const INFO = svg('<path d="M0 0h10v10H0z"/>', 'viewBox="0 0 512 512"');

const outcome = (input: string, strict: StrictMode): string[] | 'error' => {
    try {
        return convert(input, { strict, optimize: false }).warnings.map((w) => w.code);
    } catch (err) {
        if (err instanceof ConversionError) return 'error';
        throw err;
    }
};

describe('WARNING_CATEGORIES', () => {
    it('categorizes every warning code, and nothing else', () => {
        expect(Object.keys(WARNING_CATEGORIES).sort()).toEqual([...WARNING_CODES].sort());
        const allowed: WarningCategory[] = ['lossy', 'approximation', 'info'];
        for (const category of Object.values(WARNING_CATEGORIES)) expect(allowed).toContain(category);
    });

    it('splits codes by meaning', () => {
        const by = (c: WarningCategory): string[] =>
            WARNING_CODES.filter((code) => WARNING_CATEGORIES[code] === c).sort();
        expect(by('lossy')).toEqual([
            'empty-path',
            'missing-clip-path',
            'missing-gradient',
            'unsupported-attribute',
            'unsupported-clip-path',
            'unsupported-element',
            'unsupported-paint',
            'unsupported-stroke-dasharray',
            'unsupported-stroke-gradient',
            'unsupported-style',
        ]);
        expect(by('approximation')).toEqual([
            'gradient-approximated',
            'gradient-bbox-unavailable',
            'gradient-under-skew',
            'group-skew',
            'opacity-approximated',
        ]);
        expect(by('info')).toEqual(['large-vector', 'long-path-data', 'min-sdk-exceeded']);
    });
});

describe('strict presets', () => {
    it('fixtures emit the expected category of warning', () => {
        expect(outcome(LOSSY, false)).toEqual(['unsupported-stroke-dasharray']);
        expect(outcome(APPROX, false)).toEqual(['opacity-approximated']);
        expect(outcome(INFO, false)).toEqual(['large-vector']);
    });

    it('strict: true errors on lossy and approximation codes (backward compatible), not on info', () => {
        expect(outcome(LOSSY, true)).toBe('error');
        expect(outcome(APPROX, true)).toBe('error');
        expect(outcome(INFO, true)).toEqual(['large-vector']);
    });

    it("strict: 'lossy' errors on lossy codes only", () => {
        expect(outcome(LOSSY, 'lossy')).toBe('error');
        expect(outcome(APPROX, 'lossy')).toEqual(['opacity-approximated']);
        expect(outcome(INFO, 'lossy')).toEqual(['large-vector']);
    });

    it('strict: true still covers every code that existed before the presets', () => {
        // The 15 codes of 0.1.x were all errors under strict: true; none may fall into `info`,
        // the only category strict: true leaves alone.
        const legacy = WARNING_CODES.slice(0, WARNING_CODES.indexOf('empty-path') + 1);
        expect(legacy).toHaveLength(15);
        for (const code of legacy) expect(WARNING_CATEGORIES[code]).not.toBe('info');
    });

    it('rules override every preset, both ways', () => {
        expect(
            convert(LOSSY, { optimize: false, strict: 'lossy', rules: { 'unsupported-stroke-dasharray': 'warn' } })
                .warnings,
        ).toHaveLength(1);
        expect(() =>
            convert(APPROX, { optimize: false, strict: 'lossy', rules: { 'opacity-approximated': 'error' } }),
        ).toThrow(ConversionError);
        expect(
            convert(APPROX, { optimize: false, strict: true, rules: { 'opacity-approximated': 'off' } }).warnings,
        ).toEqual([]);
        expect(() => convert(INFO, { strict: 'lossy', rules: { 'large-vector': 'error' } })).toThrow(ConversionError);
    });

    it('the thrown error carries the warning', () => {
        try {
            convert(LOSSY, { strict: 'lossy' });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(ConversionError);
            expect((err as ConversionError).warning.code).toBe('unsupported-stroke-dasharray');
        }
    });

    it('rejects an unknown preset', () => {
        expect(() => convert(LOSSY, { strict: 'approximation' as unknown as StrictMode })).toThrow(TypeError);
        expect(() => convert(LOSSY, { strict: 'true' as unknown as StrictMode })).toThrow(TypeError);
    });
});
