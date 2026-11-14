import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WARNING_CATEGORIES, WARNING_CODES } from '../src/index.js';

/** docs/warnings.md explains every warning code: this keeps it from drifting from the code. */
const doc = readFileSync(new URL('../docs/warnings.md', import.meta.url), 'utf8');

/** The heading (`### \`code\``) under which each code is explained, and the section it sits in. */
function sectionOf(code: string): string | undefined {
    const at = doc.indexOf(`### \`${code}\``);
    if (at === -1) return undefined;
    const before = doc.slice(0, at);
    return before.slice(before.lastIndexOf('\n## ') + 4).split('\n')[0];
}

describe('docs/warnings.md', () => {
    it.each(WARNING_CODES.map((code) => [code]))('explains %s under its category, with a summary row', (code) => {
        const section = sectionOf(code);
        expect(section, `### \`${code}\` heading`).toBeDefined();
        expect(section!.toLowerCase()).toBe(WARNING_CATEGORIES[code]);
        expect(doc).toContain(`| [\`${code}\`](#${code})`);
    });

    it('explains no code that does not exist', () => {
        const documented = [...doc.matchAll(/^### `([a-z-]+)`$/gm)].map((m) => m[1]);
        expect([...documented].sort()).toEqual([...WARNING_CODES].sort());
    });
});
