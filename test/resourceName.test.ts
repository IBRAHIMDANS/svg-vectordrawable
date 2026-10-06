import { describe, expect, it } from 'vitest';
import { androidResourceName, findNameCollisions } from '../src/resourceName.js';

const VALID = /^[a-z][a-z0-9_]*$/;

describe('androidResourceName', () => {
    it.each([
        ['icon', 'icon'],
        ['Arrow-Left', 'arrow_left'],
        ['arrowLeft', 'arrow_left'],
        ['ArrowLeft', 'arrow_left'],
        ['XMLHttpIcon', 'xml_http_icon'],
        ['ic_home_24', 'ic_home_24'],
        ['icon 24px', 'icon_24px'],
        ['a--b..c', 'a_b_c'],
        ['__a__b__', 'a_b'],
        ['-arrow-', 'arrow'],
        ['café', 'cafe'],
        ['arrow.left@2x', 'arrow_left_2x'],
    ])('%s → %s', (input, expected) => {
        expect(androidResourceName(input)).toBe(expected);
    });

    it('prefixes names starting with a digit', () => {
        expect(androidResourceName('24-hours')).toBe('ic_24_hours');
        expect(androidResourceName('3d')).toBe('ic_3d');
    });

    it('falls back to a valid name when nothing usable remains', () => {
        expect(androidResourceName('')).toBe('ic');
        expect(androidResourceName('---')).toBe('ic');
        expect(androidResourceName('日本')).toBe('ic');
    });

    it('suffixes Java reserved keywords', () => {
        expect(androidResourceName('new')).toBe('new_');
        expect(androidResourceName('Class')).toBe('class_');
        expect(androidResourceName('int')).toBe('int_');
        expect(androidResourceName('switch')).toBe('switch_');
        expect(androidResourceName('null')).toBe('null_');
        expect(androidResourceName('newer')).toBe('newer');
    });

    it('always yields a valid resource name', () => {
        for (const input of ['Arrow-Left', '1', '', 'new', '__', 'A1b2-C3', 'Ω-ω', '_9']) {
            expect(androidResourceName(input)).toMatch(VALID);
        }
    });

    it('is idempotent', () => {
        for (const input of ['Arrow-Left', '24-hours', 'new', 'XMLHttpIcon']) {
            const once = androidResourceName(input);
            expect(androidResourceName(once)).toBe(once);
        }
    });
});

describe('findNameCollisions', () => {
    it('returns nothing when all names are distinct', () => {
        expect(
            findNameCollisions([
                { input: 'a.svg', name: 'a' },
                { input: 'b.svg', name: 'b' },
            ]),
        ).toEqual([]);
    });

    it('groups the inputs sharing a name', () => {
        expect(
            findNameCollisions([
                { input: 'Arrow-Left.svg', name: 'arrow_left' },
                { input: 'b.svg', name: 'b' },
                { input: 'arrow_left.svg', name: 'arrow_left' },
            ]),
        ).toEqual([{ name: 'arrow_left', inputs: ['Arrow-Left.svg', 'arrow_left.svg'] }]);
    });
});
