import { _collections } from './svgo.js';
import type { AndroidColor } from './types.js';

// svgo ships the CSS named-color table (e.g. `red` → `#f00`); reuse it instead of maintaining one.
const NAMED: Record<string, string> = {
    ...((_collections as { colorsNames?: Record<string, string> }).colorsNames ?? {}),
    transparent: 'rgba(0,0,0,0)',
};

interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);
const hex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
const apply = (m: Mat3, v: Vec3): Vec3 => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const map3 = (v: Vec3, f: (c: number) => number): Vec3 => [f(v[0]), f(v[1]), f(v[2])];

function hslToRgb(h: number, s: number, l: number): Rgba {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    // Every branch below assigns all three channels.
    let r: number;
    let g: number;
    let b: number;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}

function hwbToRgb(h: number, w: number, b: number): Rgba {
    w = clamp(w, 0, 1);
    b = clamp(b, 0, 1);
    if (w + b >= 1) {
        const gray = (w / (w + b)) * 255;
        return { r: gray, g: gray, b: gray, a: 1 };
    }
    const pure = hslToRgb(h, 1, 0.5);
    const mix = (c: number): number => c * (1 - w - b) + w * 255;
    return { r: mix(pure.r), g: mix(pure.g), b: mix(pure.b), a: 1 };
}

// ---- CSS Color 4 color spaces -------------------------------------------------------------------
// Every space is converted to CIE XYZ (D65), then to sRGB. Matrices and transfer functions are the
// ones of the CSS Color 4 sample code (https://www.w3.org/TR/css-color-4/#color-conversion-code).
// sRGB is the only gamut a VectorDrawable can express: out-of-gamut colors are clipped channel by
// channel (not the CSS gamut-mapping algorithm, which reduces OKLCH chroma); in-gamut colors are exact.

/** Linear-light sRGB from XYZ D65. */
const XYZ_TO_LINEAR_SRGB: Mat3 = [
    [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
    [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
    [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
/** Bradford chromatic adaptation D50 → D65. */
const D50_TO_D65: Mat3 = [
    [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
    [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
    [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const D50_WHITE: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const OKLAB_TO_LMS: Mat3 = [
    [1, 0.3963377773761749, 0.2158037573099136],
    [1, -0.1055613458156586, -0.0638541728258133],
    [1, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_XYZ: Mat3 = [
    [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
    [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
    [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];

/** sRGB (and display-p3) transfer function: encoded → linear light (CSS Color 4 §10.2 `lin_sRGB`). */
export const srgbToLinear = (c: number): number => {
    const abs = Math.abs(c);
    return abs <= 0.04045 ? c / 12.92 : Math.sign(c) * ((abs + 0.055) / 1.055) ** 2.4;
};
/** Inverse sRGB transfer function: linear light → encoded (CSS Color 4 §10.2 `gam_sRGB`). */
export const linearToSrgb = (c: number): number => {
    const abs = Math.abs(c);
    return abs > 0.0031308 ? Math.sign(c) * (1.055 * abs ** (1 / 2.4) - 0.055) : 12.92 * c;
};

/** sRGB (0–255, clipped later by {@link hex2}) from encoded sRGB components (0–1). */
const srgb = ([r, g, b]: Vec3): Rgba => ({ r: r * 255, g: g * 255, b: b * 255, a: 1 });

/** sRGB from XYZ D65. */
const xyzToRgb = (xyz: Vec3): Rgba => srgb(map3(apply(XYZ_TO_LINEAR_SRGB, xyz), linearToSrgb));

/**
 * An RGB space to sRGB, given its transfer function (encoded → linear light) and its matrix to XYZ
 * (D50 when `d50`, adapted to D65 afterwards).
 */
const rgbSpace =
    (toLinear: (c: number) => number, toXyz: Mat3, d50 = false) =>
    (v: Vec3): Rgba => {
        const xyz = apply(toXyz, map3(v, toLinear));
        return xyzToRgb(d50 ? apply(D50_TO_D65, xyz) : xyz);
    };

/** The predefined spaces of `color()`: components to sRGB. */
const COLOR_SPACES: Record<string, (v: Vec3) => Rgba> = {
    srgb,
    'srgb-linear': (v) => srgb(map3(v, linearToSrgb)),
    'display-p3': rgbSpace(srgbToLinear, [
        [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
        [35783 / 156275, 247089 / 357200, 198249 / 2500400],
        [0, 32229 / 714400, 5220557 / 5000800],
    ]),
    'a98-rgb': rgbSpace(
        (c) => Math.sign(c) * Math.abs(c) ** (563 / 256),
        [
            [573536 / 994567, 263643 / 1420810, 187206 / 994567],
            [591459 / 1989134, 6239551 / 9945670, 374412 / 4972835],
            [53769 / 1989134, 351524 / 4972835, 4929758 / 4972835],
        ],
    ),
    'prophoto-rgb': rgbSpace(
        (c) => (Math.abs(c) <= 16 / 512 ? c / 16 : Math.sign(c) * Math.abs(c) ** 1.8),
        [
            [0.7977666449006423, 0.13518129740053308, 0.0313477341283922],
            [0.2880748288194013, 0.711835234241873, 0.00008993693872564],
            [0, 0, 0.8251046025104602],
        ],
        true,
    ),
    // BT.2020 content displayed per BT.1886 (pure 2.4 gamma), as CSS Color 4 now specifies.
    rec2020: rgbSpace(
        (c) => Math.sign(c) * Math.abs(c) ** 2.4,
        [
            [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
            [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
            [0, 19567812 / 697040785, 295819943 / 278816314],
        ],
    ),
    xyz: xyzToRgb,
    'xyz-d65': xyzToRgb,
    'xyz-d50': (v) => xyzToRgb(apply(D50_TO_D65, v)),
};

/** XYZ D65 from CIE Lab (D50). */
function labToXyz(l: number, a: number, b: number): Vec3 {
    const kappa = 24389 / 27;
    const epsilon = 216 / 24389;
    const f1 = (l + 16) / 116;
    const f0 = a / 500 + f1;
    const f2 = f1 - b / 200;
    const x = f0 ** 3 > epsilon ? f0 ** 3 : (116 * f0 - 16) / kappa;
    const y = l > kappa * epsilon ? f1 ** 3 : l / kappa;
    const z = f2 ** 3 > epsilon ? f2 ** 3 : (116 * f2 - 16) / kappa;
    return apply(D50_TO_D65, [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]]);
}

/** XYZ D65 from OKLab. */
function oklabToXyz(l: number, a: number, b: number): Vec3 {
    const lms = map3(apply(OKLAB_TO_LMS, [l, a, b]), (c) => c ** 3);
    return apply(LMS_TO_XYZ, lms);
}

/** Cartesian `[a, b]` of a polar chroma (negative clamped to 0) and hue (degrees). */
function polar(c: number, h: number): [number, number] {
    const rad = (h * Math.PI) / 180;
    return [Math.max(c, 0) * Math.cos(rad), Math.max(c, 0) * Math.sin(rad)];
}

// ---- Component parsing --------------------------------------------------------------------------

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/;
const ANGLE_UNITS: Record<string, number> = { '': 1, deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/**
 * How a channel is read: `'hue'` (a number or an angle, in degrees), or the value a `100%`
 * percentage stands for (a plain number is taken as is). `none` reads as 0.
 */
type Channel = number | 'hue';

function channel(token: string, kind: Channel): number | null {
    if (token === 'none') return 0;
    const m = NUMBER_RE.exec(token);
    if (!m) return null;
    const n = parseFloat(m[0]);
    const unit = token.slice(m[0].length);
    if (kind === 'hue') return Object.hasOwn(ANGLE_UNITS, unit) ? n * ANGLE_UNITS[unit]! : null;
    if (unit === '') return n;
    return unit === '%' ? (n / 100) * kind : null;
}

/** A color function: how its three channels are read and how they map to sRGB. */
interface ColorFunction {
    channels: readonly [Channel, Channel, Channel];
    toRgb: (v: Vec3) => Rgba;
}

const RGB_FN: ColorFunction = { channels: [255, 255, 255], toRgb: ([r, g, b]) => ({ r, g, b, a: 1 }) };
// Saturation / lightness: a percentage, or (CSS Color 4) a number on the same 0–100 scale.
const HSL_FN: ColorFunction = { channels: ['hue', 100, 100], toRgb: ([h, s, l]) => hslToRgb(h, s / 100, l / 100) };

const FUNCTIONS: Record<string, ColorFunction> = {
    rgb: RGB_FN,
    rgba: RGB_FN,
    hsl: HSL_FN,
    hsla: HSL_FN,
    hwb: { channels: ['hue', 100, 100], toRgb: ([h, w, b]) => hwbToRgb(h, w / 100, b / 100) },
    lab: { channels: [100, 125, 125], toRgb: ([l, a, b]) => xyzToRgb(labToXyz(clamp(l, 0, 100), a, b)) },
    lch: { channels: [100, 150, 'hue'], toRgb: ([l, c, h]) => xyzToRgb(labToXyz(clamp(l, 0, 100), ...polar(c, h))) },
    oklab: { channels: [1, 0.4, 0.4], toRgb: ([l, a, b]) => xyzToRgb(oklabToXyz(clamp(l, 0, 1), a, b)) },
    oklch: { channels: [1, 0.4, 'hue'], toRgb: ([l, c, h]) => xyzToRgb(oklabToXyz(clamp(l, 0, 1), ...polar(c, h))) },
};

const LEGACY = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

/** A CSS token of a color function: a number with its unit, an identifier, `,` or `/`. */
const TOKEN_RE = /\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|[a-z]+)?|[a-z][a-z0-9-]*|[,/])\s*/y;

/**
 * Tokens of a function body, null on anything else. Numbers need no separator, as in CSS: a
 * minifier may emit `lab(54.9-34.7 6.4)` for `lab(54.9 -34.7 6.4)`.
 */
function tokenize(body: string): string[] | null {
    const tokens: string[] = [];
    TOKEN_RE.lastIndex = 0;
    while (TOKEN_RE.lastIndex < body.length) {
        const m = TOKEN_RE.exec(body);
        if (!m) return null;
        tokens.push(m[1]!);
    }
    return tokens;
}

/**
 * Parses the body of a color function `name(…)`: `c1 c2 c3 [/ alpha]`, `color(<space> c1 c2 c3 [/ alpha])`,
 * and for `rgb[a]()` / `hsl[a]()` also the legacy `c1, c2, c3[, alpha]`. Null when malformed.
 */
function parseFunction(name: string, body: string): Rgba | null {
    const all = tokenize(body);
    if (!all || (!LEGACY.has(name) && all.includes(','))) return null;
    const slash = all.indexOf('/');
    const tokens = (slash < 0 ? all : all.slice(0, slash)).filter((t) => t !== ',');
    let alphaToken: string | undefined;
    if (slash >= 0) {
        if (slash !== all.length - 2 || all[slash + 1] === ',') return null;
        alphaToken = all[slash + 1];
    }

    let fn: ColorFunction | undefined;
    if (name === 'color') {
        const space = tokens.shift();
        const toRgb = space !== undefined && Object.hasOwn(COLOR_SPACES, space) ? COLOR_SPACES[space] : undefined;
        if (toRgb) fn = { channels: [1, 1, 1], toRgb };
    } else if (Object.hasOwn(FUNCTIONS, name)) fn = FUNCTIONS[name];
    if (!fn) return null;
    // Legacy syntax: the alpha is a fourth comma-separated value.
    if (alphaToken === undefined && LEGACY.has(name) && tokens.length === 4) alphaToken = tokens.pop();
    if (tokens.length !== 3) return null;

    const [c0, c1, c2] = tokens.map((t, i) => channel(t, fn.channels[i]!));
    const alpha = alphaToken === undefined ? 1 : channel(alphaToken, 1);
    if (alpha === null || c0 == null || c1 == null || c2 == null) return null;
    return { ...fn.toRgb([c0, c1, c2]), a: clamp(alpha, 0, 1) };
}

function parseRgba(raw: string, currentColor: string, seen = 0): Rgba | null {
    if (seen > 4) return null; // guard against currentColor → currentColor loops
    const value = raw.trim().toLowerCase();

    if (value === 'none') return null;
    if (value === 'currentcolor') return parseRgba(currentColor, currentColor, seen + 1);

    if (value.startsWith('#')) {
        const h = value.slice(1);
        if (!/^[0-9a-f]+$/.test(h)) return null;
        const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
        if (h.length === 3 || h.length === 4) {
            return {
                r: expand(h[0]!),
                g: expand(h[1]!),
                b: expand(h[2]!),
                a: h.length === 4 ? expand(h[3]!) / 255 : 1,
            };
        }
        if (h.length === 6 || h.length === 8) {
            return {
                r: parseInt(h.slice(0, 2), 16),
                g: parseInt(h.slice(2, 4), 16),
                b: parseInt(h.slice(4, 6), 16),
                a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
            };
        }
        return null;
    }

    // No nested parentheses: `calc()`, `var()` and relative colors (`from …`) are not resolved.
    const fn = /^([a-z]+)\(([^()]*)\)$/.exec(value);
    if (fn) return parseFunction(fn[1]!, fn[2]!);

    if (Object.hasOwn(NAMED, value)) return parseRgba(NAMED[value]!, currentColor, seen + 1);
    return null;
}

/**
 * Converts an SVG / CSS color plus an optional extra opacity into an Android `#AARRGGBB`:
 * `#rgb[a]`, `#rrggbb[aa]`, named colors, `currentColor`, `transparent`, and the CSS Color 4
 * functions `rgb[a]()`, `hsl[a]()` (legacy comma or modern space syntax), `hwb()`, `lab()`, `lch()`,
 * `oklab()`, `oklch()` and `color()` in a predefined space (`srgb`, `srgb-linear`, `display-p3`,
 * `a98-rgb`, `prophoto-rgb`, `rec2020`, `xyz`, `xyz-d50`, `xyz-d65`); `none` components count as 0.
 * Colors outside sRGB are clipped per channel (see the color-space section above).
 * Returns `null` for `none` and for unparseable values (`calc()`, `var()`, `color-mix()`, relative
 * colors, system colors…): the caller decides whether that is "no paint" or an unsupported one.
 */
export function toAndroidColor(
    value: string | undefined,
    opacity: number | undefined,
    currentColor: string,
): AndroidColor | null {
    if (value === undefined) return null;
    const rgba = parseRgba(value, currentColor);
    if (!rgba) return null;
    const a = clamp(rgba.a * (opacity ?? 1), 0, 1);
    return `#${hex2(a * 255)}${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`.toUpperCase() as AndroidColor;
}
