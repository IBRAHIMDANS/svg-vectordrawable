import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';

const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${inner}</svg>`;

// Dense, same-style, touching unit squares: the worst case for svgo's mergePaths.
const grid = (n: number): string => {
    let out = '';
    for (let i = 0; i < n; i++) {
        out += `<path fill="#333" d="M${i % 1000} ${Math.floor(i / 10) % 1000}h1v1h-1z"/>`;
    }
    return out;
};

const countPaths = (xml: string): number => xml.split('<path').length - 1;

const twoMergeable = '<path fill="#f00" d="M0 0h10v10H0z"/><path fill="#f00" d="M20 0h10v10H20z"/>';

describe('normalize: mergePaths threshold', () => {
    it('merges adjacent same-style paths on small inputs', () => {
        expect(countPaths(convert(svg(twoMergeable)).xml)).toBe(1);
    });

    it('skips mergePaths above the threshold', () => {
        expect(countPaths(convert(svg(grid(600))).xml)).toBe(600);
    });

    it('ignores drawable tags inside comments when counting', () => {
        const xml = convert(svg(`<!--${grid(600)}-->${twoMergeable}`)).xml;
        expect(countPaths(xml)).toBe(1);
    });

    it('converts 10,000 paths with optimize:true in near-linear time', () => {
        const input = svg(grid(10_000));
        const start = performance.now();
        const { xml } = convert(input);
        const elapsed = performance.now() - start;
        expect(countPaths(xml)).toBe(10_000);
        // ~0.5-1.7 s locally (24.6 s before the threshold). The path count above is the deterministic
        // check; this bound only catches a return of the quadratic blow-up on a loaded CI runner.
        expect(elapsed).toBeLessThan(8_000);
    }, 20_000);
});

describe('normalize: convertPathData threshold', () => {
    const zigzag = (n: number): string => `<path fill="none" stroke="#000" d="M0 0${'l1 1l1-1'.repeat(n / 2)}"/>`;

    it('keeps svgo path optimization on ordinary paths', () => {
        // svgo rewrites `L10 0` as the shorter `h10`.
        expect(convert(svg('<path d="M0 0L10 0L10 10z"/>')).xml).toContain('android:pathData="M0 0h10v10z"');
    });

    it('converts a 40,000-segment path with optimize:true in near-linear time', () => {
        const input = svg(zigzag(40_000));
        const start = performance.now();
        const { xml } = convert(input);
        const elapsed = performance.now() - start;
        // Same geometry as without svgo: the path is emitted as authored.
        expect(xml).toBe(convert(input, { optimize: false }).xml);
        // ~0.1 s locally (about 10 s with convertPathData on); the bound only catches the blow-up.
        expect(elapsed).toBeLessThan(5_000);
    }, 30_000);
});

describe('normalize: user svgoConfig', () => {
    it('is used as-is: mergePaths stays on for large inputs', () => {
        const svgoConfig = { plugins: ['preset-default' as const] };
        expect(countPaths(convert(svg(grid(600)), { svgoConfig }).xml)).toBe(1);
    });

    it('is used as-is: mergePaths can be turned off for small inputs', () => {
        const svgoConfig = {
            plugins: [{ name: 'preset-default' as const, params: { overrides: { mergePaths: false as const } } }],
        };
        expect(countPaths(convert(svg(twoMergeable), { svgoConfig }).xml)).toBe(2);
    });
});
