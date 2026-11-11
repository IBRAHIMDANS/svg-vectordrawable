import { toAndroidColor } from './color.js';
import { formatNumber } from './format.js';
import type { Warning } from './types.js';

/** A resource / package name: what aapt2 accepts in a reference (`brand`, `color_primary`, `com.example`). */
const NAME = '[a-zA-Z_][a-zA-Z0-9_.]*';

/**
 * An Android color reference: a color resource `@[package:]color/name` or a theme attribute
 * `?[package:]attr/name` (e.g. `@color/brand`, `@android:color/white`, `?attr/colorPrimary`,
 * `?android:attr/colorAccent`). The shorthand `?name` is not accepted: the type is always explicit.
 */
const REFERENCE_RE = new RegExp(`^(?:@(?:${NAME}:)?color|\\?(?:${NAME}:)?attr)/${NAME}$`);

const EXPECTED = 'expected @[package:]color/name or ?[package:]attr/name';

/** True when `value` is a well-formed Android color reference (see {@link REFERENCE_RE}). */
export const isColorReference = (value: string): boolean => REFERENCE_RE.test(value);

/** A solid paint ready to emit: an Android literal, or a reference with the alpha it cannot carry. */
export interface ResolvedColor {
    /** `#AARRGGBB` or a reference, emitted as is in `android:fillColor` / `android:strokeColor`. */
    color: string;
    /** Alpha left for `fillAlpha` / `strokeAlpha` (a reference has none): 1 for a literal. */
    alpha: number;
}

/** Resolves SVG colors to the Android literals or references of the `currentColor` / `colorMap` options. */
export interface ColorRefs {
    /**
     * Resolves a solid fill / stroke color, `color` being the element's computed CSS `color` (what
     * `currentColor` stands for). Null for `none` and unparseable values.
     */
    paint(value: string, color: string): ResolvedColor | null;
    /**
     * Resolves a gradient stop color with its `stop-opacity`. A `<gradient>` `<item>` has no alpha
     * attribute: a translucent stop keeps its literal color (black for a `currentColor` reference)
     * and is reported once per gradient. Null for unparseable values.
     */
    stop(value: string, opacity: number | undefined, gradientId: string): string | null;
}

/** Alpha component (0–1) of an Android `#AARRGGBB` literal. */
const alphaOf = (literal: string): number => parseInt(literal.slice(1, 3), 16) / 255;

const isCurrentColor = (value: string): boolean => value.trim().toLowerCase() === 'currentcolor';

/**
 * Why a fully transparent option color is refused. CSS reads 8 hex digits as `#RRGGBBAA`, so the
 * Android `#AARRGGBB` black `#FF000000` is red at alpha 0: every shape painted with it would vanish
 * without a warning. A zero alpha is never useful here (a transparent `currentColor` hides its shapes,
 * a transparent `colorMap` key only matches invisible paints), so it throws instead of guessing the
 * notation; 8 digits with a non-zero alpha stay CSS, as documented.
 */
const TRANSPARENT = 'fully transparent; 8 hex digits are CSS #RRGGBBAA, not Android #AARRGGBB';

/**
 * Validates the `currentColor` and `colorMap` options (`TypeError` on a malformed value) and returns
 * their resolver. `currentColor` is a CSS color or an Android reference. `colorMap` maps SVG colors,
 * compared as `#AARRGGBB`, to references: an exact key wins, otherwise an opaque key matches its RGB
 * at any alpha, which then goes to `fillAlpha` / `strokeAlpha`. A fully transparent `currentColor`
 * or key throws too (see {@link TRANSPARENT}). `warn` reports translucent stops.
 */
export function colorRefs(
    currentColor: string,
    colorMap: Readonly<Record<string, string>> | undefined,
    warn: (w: Warning) => void = () => {},
): ColorRefs {
    if (typeof currentColor !== 'string')
        throw new TypeError(`Invalid currentColor: ${String(currentColor)} (expected a string)`);
    const current = currentColor.trim();
    const currentRef = isColorReference(current) ? current : null;
    // An unparseable color would silently drop every shape painted with `currentColor`.
    const currentLiteral = currentRef === null ? toAndroidColor(current, 1, current) : null;
    if (currentRef === null && currentLiteral === null)
        throw new TypeError(
            /^[@?]/.test(current)
                ? `Invalid currentColor: ${JSON.stringify(currentColor)} (malformed reference, ${EXPECTED})`
                : `Invalid currentColor: ${JSON.stringify(currentColor)} (expected a CSS color or an Android color reference)`,
        );
    if (currentLiteral?.startsWith('#00'))
        throw new TypeError(`Invalid currentColor: ${JSON.stringify(currentColor)} (${TRANSPARENT})`);

    const map = new Map<string, string>();
    if (colorMap !== undefined) {
        if (typeof colorMap !== 'object' || colorMap === null || Array.isArray(colorMap))
            throw new TypeError(`Invalid colorMap: expected an object of { color: reference }`);
        for (const [key, value] of Object.entries(colorMap)) {
            // `none` as the currentColor makes a `currentColor` key unparseable: use the option instead.
            const literal = toAndroidColor(key, undefined, 'none');
            if (literal === null)
                throw new TypeError(`Invalid colorMap key: ${JSON.stringify(key)} (expected a CSS color)`);
            if (literal.startsWith('#00'))
                throw new TypeError(`Invalid colorMap key: ${JSON.stringify(key)} (${TRANSPARENT})`);
            const ref = typeof value === 'string' ? value.trim() : '';
            if (!isColorReference(ref))
                throw new TypeError(
                    `Invalid colorMap value for ${JSON.stringify(key)}: ${JSON.stringify(value)} (${EXPECTED})`,
                );
            const previous = map.get(literal);
            if (previous !== undefined && previous !== ref)
                throw new TypeError(`colorMap maps ${literal} twice: to ${previous} and to ${ref}`);
            map.set(literal, ref);
        }
    }

    /** The reference a literal maps to: exact `#AARRGGBB` key first, then the opaque key of its RGB. */
    const lookup = (literal: string): string | undefined => map.get(literal) ?? map.get(`#FF${literal.slice(3)}`);
    const reported = new Set<string>();

    return {
        paint(value, color) {
            // Only `currentColor` (inheriting the option) yields the reference: never a `fill` written in the SVG.
            if (currentRef !== null && isCurrentColor(value) && color.trim() === currentRef)
                return { color: currentRef, alpha: 1 };
            const literal = toAndroidColor(value, undefined, color);
            if (literal === null) return null;
            const ref = lookup(literal);
            return ref === undefined ? { color: literal, alpha: 1 } : { color: ref, alpha: alphaOf(literal) };
        },
        stop(value, opacity, gradientId) {
            const themed = currentRef !== null && isCurrentColor(value);
            // A `currentColor` reference has no literal: black, the option's default, stands in.
            const literal = toAndroidColor(themed ? '#000000' : value, opacity, current);
            if (literal === null) return null;
            const ref = themed ? currentRef : lookup(literal);
            if (ref === undefined) return literal;
            if (literal.startsWith('#FF')) return ref;
            if (!reported.has(gradientId)) {
                reported.add(gradientId);
                warn({
                    code: 'unsupported-color-reference',
                    message: `Gradient "${gradientId}" has a translucent stop mapped to ${ref}: a gradient <item> has no alpha, so the literal ${literal} is kept and does not follow the theme.`,
                    node: 'stop',
                });
            }
            return literal;
        },
    };
}

/**
 * `fillAlpha` / `strokeAlpha` value for an opacity `base` and the alpha a reference left over, or null
 * when opaque. Without a reference the value is emitted unrounded, as before; with one, rounded to 3
 * decimals (enough for an 8-bit alpha).
 */
export function alphaAttr(base: number, colorAlpha: number): string | null {
    const alpha = Math.max(base * colorAlpha, 0);
    if (alpha >= 1) return null;
    return colorAlpha === 1 ? String(alpha) : formatNumber(alpha, 3);
}
