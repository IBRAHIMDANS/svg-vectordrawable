import type { ClipPaths } from './clip.js';
import type { RawGradient, XastElement } from './gradient.js';
import type { Warning } from './types.js';

/** State shared by the renderers of one conversion. */
export interface ConvertContext {
    /** Reports a warning (or throws, per `strict` / `rules`). */
    readonly warn: (w: Warning) => void;
    /** Decimal places kept for generated numbers (`floatPrecision`). */
    readonly precision: number;
    /** One indentation level. */
    readonly step: string;
    readonly fillBlackForUnfilled: boolean;
    /** Gradients by id. */
    readonly gradients: ReadonlyMap<string, RawGradient>;
    /** Ids of `<pattern>` paint servers (not representable). */
    readonly patternIds: ReadonlySet<string | undefined>;
    readonly clips: ClipPaths;
    /** Synthetic copies of elements whose unsupported attributes were already reported. */
    readonly reported: WeakSet<XastElement>;
    /** Set once a gradient is emitted: the `<vector>` then declares the `aapt` namespace. */
    usesGradient: boolean;
}
