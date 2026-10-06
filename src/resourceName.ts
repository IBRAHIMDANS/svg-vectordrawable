/**
 * Android file-based resource names must match `[a-z][a-z0-9_]*` and must not be a Java keyword,
 * since each one becomes a field of the generated `R` class (`R.drawable.<name>`).
 */

/** Prefix for names that would start with a digit; also the fallback when nothing usable remains. */
const NAME_PREFIX = 'ic';

/** Java reserved keywords and literals, which are not valid `R` field names. */
const JAVA_RESERVED = new Set([
    'abstract',
    'assert',
    'boolean',
    'break',
    'byte',
    'case',
    'catch',
    'char',
    'class',
    'const',
    'continue',
    'default',
    'do',
    'double',
    'else',
    'enum',
    'extends',
    'false',
    'final',
    'finally',
    'float',
    'for',
    'goto',
    'if',
    'implements',
    'import',
    'instanceof',
    'int',
    'interface',
    'long',
    'native',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'short',
    'static',
    'strictfp',
    'super',
    'switch',
    'synchronized',
    'this',
    'throw',
    'throws',
    'transient',
    'true',
    'try',
    'void',
    'volatile',
    'while',
]);

/**
 * Turns a file base name (without extension) into a valid Android resource name:
 * accents stripped, camelCase split (`arrowLeft` → `arrow_left`), lowercased, every run of other
 * characters replaced by a single `_`, leading/trailing `_` trimmed. A name starting with a digit
 * gets an `ic_` prefix (`24-hours` → `ic_24_hours`), an empty one becomes `ic`, and a Java
 * keyword gets a `_` suffix (`new` → `new_`). Idempotent.
 */
export function androidResourceName(baseName: string): string {
    const name = baseName
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (name === '') return NAME_PREFIX;
    if (/^[0-9]/.test(name)) return `${NAME_PREFIX}_${name}`;
    return JAVA_RESERVED.has(name) ? `${name}_` : name;
}

export interface NameCollision {
    name: string;
    inputs: string[];
}

/** Groups the inputs that map to the same name, in input order; empty when all names are distinct. */
export function findNameCollisions(entries: readonly { input: string; name: string }[]): NameCollision[] {
    const byName = new Map<string, string[]>();
    for (const { input, name } of entries) byName.set(name, [...(byName.get(name) ?? []), input]);
    return [...byName].filter(([, inputs]) => inputs.length > 1).map(([name, inputs]) => ({ name, inputs }));
}

/** Throws a single error listing every collision, if any. */
export function assertNoNameCollisions(entries: readonly { input: string; name: string }[]): void {
    const collisions = findNameCollisions(entries);
    if (collisions.length === 0) return;
    const lines = collisions.map((c) => `  ${c.name}: ${c.inputs.join(', ')}`);
    throw new Error(`Android resource name collision (nothing written):\n${lines.join('\n')}`);
}
