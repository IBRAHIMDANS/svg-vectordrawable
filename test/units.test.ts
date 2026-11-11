import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { parseLength, parseOpacity } from '../src/units.js';

describe('parseOpacity', () => {
    it('parses plain numbers and clamps them to [0, 1]', () => {
        expect(parseOpacity('0.5')).toBe(0.5);
        expect(parseOpacity(' 1 ')).toBe(1);
        expect(parseOpacity('2')).toBe(1);
        expect(parseOpacity('-0.3')).toBe(0);
    });

    it('parses percentages', () => {
        expect(parseOpacity('50%')).toBe(0.5);
        expect(parseOpacity('150%')).toBe(1);
    });

    it('returns the fallback for missing or unparseable values', () => {
        expect(parseOpacity(undefined)).toBe(1);
        expect(parseOpacity('abc')).toBe(1);
        expect(parseOpacity('abc', 0.25)).toBe(0.25);
    });
});

describe('parseLength', () => {
    it('parses unitless and px values', () => {
        expect(parseLength('12')).toBe(12);
        expect(parseLength('12px')).toBe(12);
        expect(parseLength(' 1.5e1 ')).toBe(15);
    });

    it('converts absolute units at 96 px per inch', () => {
        expect(parseLength('2in')).toBe(192);
        expect(parseLength('2.54cm')).toBeCloseTo(96);
        expect(parseLength('25.4mm')).toBeCloseTo(96);
        expect(parseLength('3pt')).toBe(4);
        expect(parseLength('1pc')).toBe(16);
    });

    it('resolves percentages against the reference length', () => {
        expect(parseLength('50%', 24)).toBe(12);
        expect(parseLength('50%')).toBeNaN();
    });

    it('resolves em and rem at the 16 px initial font-size, like a browser', () => {
        expect(parseLength('1em')).toBe(16);
        expect(parseLength('1.5EM')).toBe(24);
        expect(parseLength('2rem')).toBe(32);
        expect(parseLength('-.5em')).toBe(-8);
        expect(parseLength('1e1em')).toBe(160);
        expect(parseLength('1e')).toBeNaN();
    });

    it('returns NaN for unsupported units and garbage', () => {
        expect(parseLength('2ex')).toBeNaN();
        expect(parseLength('2ch')).toBeNaN();
        expect(parseLength('em')).toBeNaN();
        expect(parseLength('auto')).toBeNaN();
        expect(parseLength(undefined)).toBeNaN();
    });
});

describe('em lengths in a conversion', () => {
    const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${inner}</svg>`;
    const raw = { optimize: false };

    it('draws stroke-width="1em" 16 wide', () => {
        const { xml } = convert(svg('<path d="M0 0h48" stroke="#000" stroke-width="1em"/>'), raw);
        expect(xml).toContain('android:strokeWidth="16"');
    });

    it('draws r="1em" as a circle of radius 16 instead of dropping it', () => {
        const { xml, warnings } = convert(svg('<circle cx="24" cy="24" r="1em"/>'), raw);
        expect(xml).toContain('android:pathData="M8,24a16,16 0 1 0 32,0a16,16 0 1 0 -32,0z"');
        expect(warnings).toEqual([]);
    });

    it('resolves rem like em', () => {
        const { xml } = convert(svg('<rect width="1rem" height="2rem"/>'), raw);
        expect(xml).toContain('android:pathData="M0,0h16v32h-16z"');
    });
});
