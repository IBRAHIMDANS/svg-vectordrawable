import type { ClipPaths } from './clip.js';
import type { XastElement } from './ast.js';
import type { ColorRefs } from './colorRef.js';
import type { RawGradient } from './gradient.js';
import type { Inherited } from './inherited.js';
import type { Warning } from './types.js';

/**
 * Lays out a `<text>` (its computed `style`) as glyph outlines: path data in its user space (empty
 * when it draws no glyph), or why it cannot be (reported as `unsupported-element`).
 */
export type TextLayout = (el: XastElement, style: Inherited) => { d: string } | { reason: string };

/** State shared by the renderers of one conversion. */
export interface ConvertContext {
    /** Reports a warning (or throws, per `strict` / `rules`). */
    readonly warn: (w: Warning) => void;
    /** Decimal places kept for generated numbers (`floatPrecision`). */
    readonly precision: number;
    /** One indentation level. */
    readonly step: string;
    readonly fillBlackForUnfilled: boolean;
    /**
     * Evenodd fills are rewritten as nonzero geometry when possible (`minSdk` below 24, where
     * `android:fillType` is unavailable); a fill-less path drops its unused `fillType`.
     */
    readonly nonZeroFills: boolean;
    /** Solid colors to Android literals or references (`currentColor` / `colorMap` options). */
    readonly colors: ColorRefs;
    /** Gradients by id. */
    readonly gradients: ReadonlyMap<string, RawGradient>;
    /** Ids of every `<linearGradient>` / `<radialGradient>`, including the invalid ones `gradients` leaves out. */
    readonly gradientIds: ReadonlySet<string | undefined>;
    /** Ids of `<pattern>` paint servers (not representable). */
    readonly patternIds: ReadonlySet<string | undefined>;
    readonly clips: ClipPaths;
    /**
     * Elements outside the SVG namespace (`foreignElements` of the root `<svg>`, which namespace
     * scoping needs whole). Synthetic copies made while walking are copies of SVG elements; their
     * children are the original, classified, nodes.
     */
    readonly foreign: WeakSet<XastElement>;
    /** Synthetic copies of elements whose unsupported attributes were already reported. */
    readonly reported: WeakSet<XastElement>;
    /** `android:name` values emitted so far (`preserveIds`, names must be unique); null when off. */
    readonly names: Set<string> | null;
    /** `<text>` to glyph outlines, from the `fonts` option (text.ts); undefined without it. */
    readonly text?: TextLayout;
    /** Set once a gradient is emitted: the `<vector>` then declares the `aapt` namespace. */
    usesGradient: boolean;
}
