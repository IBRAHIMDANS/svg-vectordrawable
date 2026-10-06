import { describe, expect, it } from 'vitest';
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

    it('returns NaN for unsupported units and garbage', () => {
        expect(parseLength('2em')).toBeNaN();
        expect(parseLength('2ex')).toBeNaN();
        expect(parseLength('auto')).toBeNaN();
        expect(parseLength(undefined)).toBeNaN();
    });
});
