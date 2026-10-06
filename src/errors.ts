import type { Warning } from './types.js';

/** Thrown when a warning's severity resolves to `'error'` (via `strict` or `rules`). */
export class ConversionError extends Error {
    /** The warning that stopped the conversion. */
    readonly warning: Warning;

    constructor(warning: Warning) {
        super(`[${warning.code}] ${warning.message}`);
        this.name = 'ConversionError';
        this.warning = warning;
    }
}
