import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { androidResourceName, findNameCollisions } from '../src/resourceName.js';
import { propertyParams, propertyTimeout } from './property.js';

/** Property-based tests of Android resource names (T-177, step 3). */

/** Java keywords and literals: an `R.drawable.<name>` field cannot be one of them. */
const JAVA_RESERVED = new Set(
    (
        'abstract assert boolean break byte case catch char class const continue default do double else enum extends ' +
        'false final finally float for goto if implements import instanceof int interface long native new null ' +
        'package private protected public return short static strictfp super switch synchronized this throw throws ' +
        'transient true try void volatile while'
    ).split(' '),
);

/** File base names: any Unicode text, plus ASCII names made of the parts that trip naming rules. */
const baseName = fc.oneof(
    fc.string({ unit: 'grapheme', maxLength: 30 }),
    fc.string({ unit: 'binary', maxLength: 30 }),
    fc
        .array(
            fc.oneof(
                fc.constantFrom(
                    'new',
                    'class',
                    'true',
                    'ic',
                    'Arrow',
                    'left',
                    'HTML',
                    'URLs',
                    '24',
                    '_',
                    '-',
                    ' ',
                    '.',
                    'é',
                    'İ',
                    'ß',
                ),
                fc.stringMatching(/^[A-Za-z0-9]{1,4}$/),
            ),
            { maxLength: 6 },
        )
        .map((parts) => parts.join('')),
);

describe('androidResourceName (property)', { timeout: propertyTimeout }, () => {
    it('always gives a valid Android resource name that is not a Java keyword', () => {
        fc.assert(
            fc.property(baseName, (name) => {
                const out = androidResourceName(name);
                expect(out).toMatch(/^[a-z][a-z0-9_]*$/);
                expect(JAVA_RESERVED.has(out)).toBe(false);
            }),
            propertyParams,
        );
    });

    it('is idempotent', () => {
        fc.assert(
            fc.property(baseName, (name) => {
                const once = androidResourceName(name);
                expect(androidResourceName(once)).toBe(once);
            }),
            propertyParams,
        );
    });

    it('keeps a name that is already valid, lowercase and not a keyword', () => {
        fc.assert(
            fc.property(fc.stringMatching(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/), (name) => {
                fc.pre(!JAVA_RESERVED.has(name));
                expect(androidResourceName(name)).toBe(name);
            }),
            propertyParams,
        );
    });
});

describe('findNameCollisions (property)', { timeout: propertyTimeout }, () => {
    const entries = fc.array(
        fc.record({ input: fc.string({ maxLength: 8 }), name: fc.stringMatching(/^[a-cA-C]{1,2}$/) }),
        { maxLength: 12 },
    );

    it('reports exactly the inputs whose names are equal ignoring case, in input order', () => {
        fc.assert(
            fc.property(entries, (list) => {
                const groups = findNameCollisions(list);
                const count = new Map<string, number>();
                for (const { name } of list) count.set(name.toLowerCase(), (count.get(name.toLowerCase()) ?? 0) + 1);
                const shared = list.filter(({ name }) => count.get(name.toLowerCase())! > 1);
                expect(groups.flatMap((g) => g.inputs).sort()).toEqual(shared.map((e) => e.input).sort());
                for (const g of groups) {
                    const members = list.filter(({ name }) => g.name.split(', ').includes(name));
                    expect(g.inputs).toEqual(members.map((e) => e.input));
                    expect(new Set(members.map((e) => e.name.toLowerCase())).size).toBe(1);
                }
            }),
            propertyParams,
        );
    });

    it('is empty when every name is distinct ignoring case', () => {
        fc.assert(
            fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,3}$/), { maxLength: 10 }), (names) => {
                const list = names.map((name, i) => ({ input: `f${i}`, name: i % 2 ? name.toUpperCase() : name }));
                expect(findNameCollisions(list)).toEqual([]);
            }),
            propertyParams,
        );
    });
});
