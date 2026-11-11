import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { colorRefs } from '../src/colorRef.js';

const path = (attrs: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h9v9z" ${attrs}/></svg>`;
const raw = { optimize: false } as const;

describe('fully transparent option colors (Android #AARRGGBB written as CSS #RRGGBBAA)', () => {
    it.each(['#FF000000', '#ff000000', ' #00FF0000 ', '#0000', 'transparent', 'rgba(0, 0, 0, 0)', 'hsl(0 0% 0% / 0)'])(
        'rejects currentColor %j with a TypeError naming the CSS notation',
        (currentColor) => {
            expect(() => colorRefs(currentColor, undefined)).toThrow(TypeError);
            expect(() => convert(path('fill="currentColor"'), { currentColor })).toThrow(
                /Invalid currentColor: .*fully transparent; 8 hex digits are CSS #RRGGBBAA, not Android #AARRGGBB/,
            );
        },
    );

    it('throws even when no shape uses currentColor (the option is validated up front)', () => {
        expect(() => convert(path('fill="#f00"'), { currentColor: '#FF000000' })).toThrow(TypeError);
    });

    it.each(['#000000FF', '#000', '#000000', 'black', '#000f'])(
        'reads currentColor %j as opaque black',
        (currentColor) => {
            const { xml } = convert(path('fill="currentColor"'), { ...raw, currentColor });
            expect(xml).toContain('android:fillColor="#FF000000"');
            expect(xml).toBe(convert(path('fill="currentColor"'), raw).xml);
        },
    );

    it.each([
        ['#FF000080', '#80FF0000'],
        ['#1A73E801', '#011A73E8'],
        ['#f008', '#88FF0000'],
        ['rgba(0, 0, 255, 0.5)', '#800000FF'],
    ])('keeps a translucent currentColor %j as CSS (%s)', (currentColor, literal) => {
        const { xml } = convert(path('fill="currentColor"'), { ...raw, currentColor });
        expect(xml).toContain(`android:fillColor="${literal}"`);
    });

    it('keeps accepting references', () => {
        const { xml } = convert(path('fill="currentColor"'), { ...raw, currentColor: '?attr/colorOnSurface' });
        expect(xml).toContain('android:fillColor="?attr/colorOnSurface"');
    });

    it('still rejects unparseable values with the previous messages', () => {
        expect(() => colorRefs('nope', undefined)).toThrow(/expected a CSS color or an Android color reference/);
        expect(() => colorRefs('?colorPrimary', undefined)).toThrow(/malformed reference/);
    });

    it.each(['#FF000000', 'transparent', '#0000'])(
        'rejects the colorMap key %j (it only matches invisible paints)',
        (key) => {
            expect(() => colorRefs('#000', { [key]: '@color/ink' })).toThrow(
                /Invalid colorMap key: .*fully transparent; 8 hex digits are CSS #RRGGBBAA/,
            );
            expect(() => convert(path('fill="#000"'), { colorMap: { [key]: '@color/ink' } })).toThrow(TypeError);
        },
    );

    it('keeps translucent and opaque 8-digit colorMap keys', () => {
        const map = { '#000000FF': '@color/ink', '#FF000080': '@color/half_red' };
        const opaque = convert(path('fill="#000"'), { ...raw, colorMap: map }).xml;
        expect(opaque).toContain('android:fillColor="@color/ink"');
        const half = convert(path('fill="rgba(255, 0, 0, 0.5)"'), { ...raw, colorMap: map }).xml;
        expect(half).toContain('android:fillColor="@color/half_red"');
    });
});
