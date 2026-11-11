import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNameCollisions } from '../../../src/resourceName.ts';
import { uniqueResourceNames } from '../src/naming.ts';

const VALID = /^[a-z][a-z0-9_]*$/;

test('layer names become Android resource names (androidResourceName)', () => {
    assert.deepEqual(uniqueResourceNames(['Icon / Arrow Left', 'arrowRight', '24-hours', 'new', '', 'Café ✓']), [
        'icon_arrow_left',
        'arrow_right',
        'ic_24_hours',
        'new_',
        'ic',
        'cafe',
    ]);
});

test('a multiple selection never yields two layers with the same file name', () => {
    const layers = ['Arrow', 'arrow', 'ARROW', 'Arrow 2', 'arrow_2', 'Frame 1', 'Frame 1', 'Frame 1', 'frame_1_2'];
    const names = uniqueResourceNames(layers);
    assert.deepEqual(names, [
        'arrow',
        'arrow_3', // `arrow_2` is what "Arrow 2" and "arrow_2" ask for…
        'arrow_4',
        'arrow_2',
        'arrow_2_2', // …and they collide with each other in turn
        'frame_1',
        'frame_1_3', // `frame_1_2` is taken by the last layer
        'frame_1_4',
        'frame_1_2',
    ]);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(
        findNameCollisions(names.map((name, i) => ({ input: layers[i]!, name }))),
        [],
        'the library sees no collision',
    );
    for (const name of names) assert.match(name, VALID);
});

test('distinct names are left untouched and the order is kept', () => {
    assert.deepEqual(uniqueResourceNames(['b', 'a', 'c']), ['b', 'a', 'c']);
    assert.deepEqual(uniqueResourceNames([]), []);
});

test('many duplicates (e.g. 50 "Vector" layers) stay valid and distinct', () => {
    const names = uniqueResourceNames(Array.from({ length: 50 }, () => 'Vector'));
    assert.equal(new Set(names).size, 50);
    assert.equal(names[0], 'vector');
    assert.equal(names[49], 'vector_50');
    for (const name of names) assert.match(name, VALID);
});
