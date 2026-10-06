import type { XastElement } from './gradient.js';

/** Parses an inline `style` attribute into a lowercase-keyed declaration map. */
export function parseStyle(style: string | undefined): Record<string, string> {
    if (!style) return {};
    const out: Record<string, string> = {};
    for (const decl of style.split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
    }
    return out;
}

/** Reads a property from the inline `style` first, then from the attribute of the same name. */
export function presentation(el: XastElement, name: string): string | undefined {
    const attrs = el.attributes ?? {};
    return parseStyle(attrs.style)[name] ?? attrs[name];
}

export const isNone = (v: string | undefined): boolean => v === undefined || v.trim().toLowerCase() === 'none';
