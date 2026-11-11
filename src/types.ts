import type { Config as SvgoConfig } from 'svgo';

/** Every warning code the converter can emit (stable, machine-readable). */
export const WARNING_CODES = [
    /** An element a VectorDrawable cannot draw (`<text>`, `<image>`, …); skipped. */
    'unsupported-element',
    /** A non-clip `mask`, `filter`, `marker*`, `vector-effect`, `paint-order` or unsupported join; ignored. */
    'unsupported-attribute',
    /** A dash pattern that cannot be resolved (e.g. `ex` units); the stroke is drawn solid. */
    'unsupported-stroke-dasharray',
    /** No longer emitted (gradient strokes are converted); kept for compatibility. */
    'unsupported-stroke-gradient',
    /**
     * A paint VectorDrawable cannot express: a `<pattern>`, or a translucent gradient stop mapped to
     * an Android reference by `currentColor` / `colorMap` (an `<item>` has no alpha; literal kept).
     */
    'unsupported-paint',
    /** A clipPath that cannot be (fully) converted. */
    'unsupported-clip-path',
    /** `url(#id)` paint without fallback color pointing at nothing (fill: black) or at an invalid gradient (not painted). */
    'missing-gradient',
    /** `clip-path="url(#id)"` pointing at nothing; ignored. */
    'missing-clip-path',
    /** Gradient placement under a baked (skewed) transform is approximate. */
    'gradient-under-skew',
    /** objectBoundingBox gradient on a path without a measurable box; viewport used. */
    'gradient-bbox-unavailable',
    /** A skewed `<g>` transform baked into path geometry. */
    'group-skew',
    /** `opacity` folded onto overlapping children or fill+stroke; overlaps render darker. */
    'opacity-approximated',
    /**
     * A gradient VectorDrawable can only approximate: radial focal point, or an elliptical radial on a
     * path that also has a solid stroke (otherwise elliptical radials are emitted exactly).
     */
    'gradient-approximated',
    /** CSS left in a `<style>` element that could not be applied to elements; ignored. */
    'unsupported-style',
    /** A shape that produced no geometry; skipped. */
    'empty-path',
    /**
     * The output needs a higher Android API level than the `minSdk` option (gradients and
     * `android:fillType` need API 24). Only checked when `minSdk` is set.
     */
    'min-sdk-exceeded',
    /**
     * A `pathData` longer than 800 characters (Android lint `VectorPath`): slow to parse and render,
     * consider simplifying the shape. Off by default (opt in with `rules`).
     */
    'long-path-data',
    /**
     * `android:width` or `android:height` above 200dp: large vectors are slow to render and cost
     * memory (Android recommends at most 200×200dp; use a bitmap for big artwork).
     */
    'large-vector',
    /**
     * A `<mask>` converted to a clip-path by ignoring the stroke of its content (a clip-path has no
     * stroke outline): the masked area differs along the stroked outlines. Reported once per mask.
     */
    'mask-approximated',
] as const;

/** Stable machine-readable warning codes. */
export type WarningCode = (typeof WARNING_CODES)[number];

/**
 * What a warning means for the output:
 * - `lossy`: content is dropped or drawn wrong (an element, an attribute, a paint, a clip…);
 * - `approximation`: everything is drawn, but the rendering differs slightly from the SVG;
 * - `info`: the output is faithful; Android-side advice (API level, lint-style performance hints).
 */
export type WarningCategory = 'lossy' | 'approximation' | 'info';

/** The category of every warning code (see {@link WarningCategory}); drives the `strict` presets. */
export const WARNING_CATEGORIES: Readonly<Record<WarningCode, WarningCategory>> = {
    'unsupported-element': 'lossy',
    'unsupported-attribute': 'lossy',
    'unsupported-stroke-dasharray': 'lossy',
    'unsupported-stroke-gradient': 'lossy',
    'unsupported-paint': 'lossy',
    'unsupported-clip-path': 'lossy',
    'missing-gradient': 'lossy',
    'missing-clip-path': 'lossy',
    'unsupported-style': 'lossy',
    'empty-path': 'lossy',
    'gradient-under-skew': 'approximation',
    'gradient-bbox-unavailable': 'approximation',
    'group-skew': 'approximation',
    'opacity-approximated': 'approximation',
    'gradient-approximated': 'approximation',
    'mask-approximated': 'approximation',
    'min-sdk-exceeded': 'info',
    'long-path-data': 'info',
    'large-vector': 'info',
};

/**
 * `strict` presets: `true` turns every `lossy` and `approximation` warning into an error, `'lossy'`
 * only the `lossy` ones. `info` codes are never escalated by `strict` (only by `rules`).
 */
export type StrictMode = boolean | 'lossy';

/** What to do with a warning: drop it, report it, or throw a `ConversionError`. */
export type Severity = 'off' | 'warn' | 'error';

/** A non-fatal issue encountered during conversion. */
export interface Warning {
    /** Stable machine-readable code, e.g. `unsupported-element`. */
    code: WarningCode;
    /** Human-readable explanation. */
    message: string;
    /** SVG element/attribute the warning relates to, when known. */
    node?: string;
}

export interface ConvertOptions {
    /**
     * Run svgo normalization first (inline styles, shapes→paths, bake transforms…).
     * Strongly recommended; it is what makes conversion robust across SVG sources.
     * @default true
     */
    optimize?: boolean;
    /** Override the svgo config used for normalization (only when `optimize` is true). */
    svgoConfig?: SvgoConfig;
    /** Decimal places kept for generated numbers (coordinates, radii). @default 3 */
    floatPrecision?: number;
    /**
     * What `currentColor` stands for: a CSS color, or an Android color reference emitted as is in
     * `android:fillColor` / `android:strokeColor` so the icon follows the theme: `?attr/name`,
     * `?android:attr/name`, `@color/name`, `@android:color/name` (any `package:` prefix; the
     * `?name` shorthand is not accepted). A reference carries no alpha: `fill-opacity` / `opacity`
     * go to `fillAlpha` / `strokeAlpha` as usual. A malformed value throws a `TypeError`.
     * @default '#000000'
     */
    currentColor?: string;
    /**
     * SVG colors to Android color references (same syntax as a `currentColor` reference), e.g.
     * `{ '#1A73E8': '@color/brand' }`. Keys are any CSS color, compared after normalization to
     * `#AARRGGBB` (`#f00`, `red` and `rgb(255,0,0)` are one key). An exact key wins; otherwise an
     * opaque key also matches its color at any alpha, that alpha going to `fillAlpha` / `strokeAlpha`.
     * Gradient stops get the reference only when opaque (an `<item>` has no alpha): a translucent
     * one keeps its literal color, with an `unsupported-paint` warning. A malformed key or value, or
     * two keys for one color with different references, throw a `TypeError`.
     */
    colorMap?: Record<string, string>;
    /**
     * SVG paints unfilled shapes black by default. When true, paths without an
     * explicit fill get `android:fillColor="#FF000000"`. @default true
     */
    fillBlackForUnfilled?: boolean;
    /**
     * Throw a `ConversionError` on the first warning of a category instead of reporting it:
     * `true` for `lossy` and `approximation` codes, `'lossy'` for `lossy` codes only (see
     * {@link WARNING_CATEGORIES}). `info` codes keep their default severity under any preset.
     * @default false
     */
    strict?: StrictMode;
    /**
     * Per-code severity, overriding `strict` and the defaults. E.g.
     * `{ strict: true, rules: { 'opacity-approximated': 'warn' } }` rejects anything lossy but
     * tolerates approximated opacity; `{ rules: { 'long-path-data': 'warn' } }` enables that hint.
     */
    rules?: Partial<Record<WarningCode, Severity>>;
    /** Indentation width (spaces). @default 4 */
    indent?: number;
    /** Prepend an XML declaration (`<?xml version="1.0" encoding="utf-8"?>`). @default false */
    xmlTag?: boolean;
    /** Add `android:tint` to the `<vector>`. Android color literal (e.g. `#AARRGGBB`), passed verbatim. */
    tint?: string;
    /**
     * Add `android:autoMirrored="true"` to the `<vector>`: Android flips the drawable horizontally
     * in right-to-left layouts (arrows, chevrons…). @default false
     */
    autoMirrored?: boolean;
    /**
     * `android:width` in dp, replacing the size taken from the SVG; the viewport is unchanged. Alone,
     * the height follows the SVG's aspect ratio. With both `width` and `height`, a different ratio
     * stretches the drawing (as Android does). Must be a finite number greater than 0.
     */
    width?: number;
    /** `android:height` in dp; same rules as `width` (alone, the width follows the aspect ratio). */
    height?: number;
    /** Called for every warning as it happens (in addition to the returned list). */
    onWarn?: (warning: Warning) => void;
    /**
     * The app's `minSdk`: when the output needs a higher API level (see `ConvertResult.minSdk`),
     * a `min-sdk-exceeded` warning names the features responsible. Unset: no check.
     */
    minSdk?: number;
}

export interface ConvertResult {
    /** The generated Android VectorDrawable XML. */
    xml: string;
    /** All non-fatal issues encountered. */
    warnings: Warning[];
    /**
     * Lowest Android API level that renders the output natively: 24 when it uses gradients
     * (`<aapt:attr>` complex colors) or `android:fillType`, otherwise 21 (VectorDrawable itself).
     */
    minSdk: number;
}

/** An RGBA color expressed as Android `#AARRGGBB`. */
export type AndroidColor = `#${string}`;
