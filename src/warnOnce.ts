import type { ConvertContext } from './context.js';
import type { Warning } from './types.js';

/** Warnings already reported by {@link warnOnce}, per conversion (its `warn`, shared by the `ctx` copies). */
const reported = new WeakMap<ConvertContext['warn'], Set<string>>();

/**
 * Reports a warning once per code, message and conversion: a declaration inherited by several
 * painted elements, or a `<use>` instance read again, says the same thing each time (svgo, which
 * may merge those elements, would otherwise report it fewer times). Two messages stay two warnings.
 */
export function warnOnce(ctx: Pick<ConvertContext, 'warn'>, warning: Warning): void {
    let seen = reported.get(ctx.warn);
    if (!seen) reported.set(ctx.warn, (seen = new Set()));
    const key = `${warning.code}\0${warning.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    ctx.warn(warning);
}
