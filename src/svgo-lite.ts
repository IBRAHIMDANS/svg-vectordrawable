// Lightweight stand-in for the part of svgo's runtime API the converter uses (see src/svgo.ts).
// The `browser-lite` build aliases `svgo` to this module (tsup.config.ts), which drops svgo and its
// ~1 MB of plugins / CSS tooling from the bundle. It covers exactly what `optimize: false` needs:
//   - `optimize(svg, { plugins })` parses the SVG into svgo's AST shape and runs *custom* plugins
//     (the converter's capture plugin); builtin plugins (normalization) are not available;
//   - `_collections.colorsNames`, the CSS named-color table (kept identical to svgo's, see tests).
// svgo exports neither its parser nor its collections separately (package `exports` only expose
// `.` and `./browser`), hence this small XML parser mirroring svgo's sax-based one.
import type { XastElement } from './gradient.js';

interface XastRoot {
    type: 'root';
    children: XastElement[];
}

interface XastNode extends XastElement {
    value?: string;
    data?: { doctype: string };
}

interface LitePlugin {
    name?: string;
    params?: Record<string, unknown>;
    fn?: (root: XastRoot, params: Record<string, unknown>, info: Record<string, unknown>) => unknown;
}

const LITE_ONLY = 'is not available in the svg-vectordrawable/browser-lite build';

/**
 * Parses `input` and runs the given custom plugins on the tree. Only plugins carrying their own
 * `fn` are supported; their returned visitor is ignored (the converter's capture plugin returns an
 * empty one). The output is not re-serialized: `data` is always empty.
 */
export function optimize(input: string, config: { plugins?: unknown[] } = {}): { data: string } {
    const root = parseXml(input);
    for (const entry of config.plugins ?? []) {
        const plugin = (typeof entry === 'string' ? { name: entry } : entry) as LitePlugin;
        if (typeof plugin?.fn !== 'function') throw new Error(`svgo plugin "${plugin?.name}" ${LITE_ONLY}`);
        plugin.fn(root, { ...plugin.params }, { multipassCount: 0 });
    }
    return { data: '' };
}

// Same set as svgo's `_collections.textElems`: whitespace inside these elements is meaningful.
const TEXT_ELEMS = new Set([
    'a',
    'altGlyph',
    'altGlyphDef',
    'altGlyphItem',
    'glyph',
    'glyphRef',
    'text',
    'textPath',
    'tref',
    'tspan',
    'pre',
    'title',
]);

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ENTITY_DECLARATION = /<!ENTITY\s+(\S+)\s+(?:'([^']+)'|"([^"]+)")\s*>/g;
const ENTITY_REF = /&([^&;\s<]*)(;?)/g;
const MAX_ENTITY_DEPTH = 4;

/** XML `Char` production (same check as sax). */
const isXmlChar = (c: number): boolean =>
    c === 0x9 ||
    c === 0xa ||
    c === 0xd ||
    (c >= 0x20 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd) ||
    (c >= 0x10000 && c <= 0x10ffff);

class XmlError extends Error {
    constructor(message: string, source: string, offset: number) {
        const before = source.slice(0, offset).split('\n');
        super(`<input>:${before.length}:${(before[before.length - 1] ?? '').length + 1}: ${message}`);
        this.name = 'SvgoParserError';
    }
}

/**
 * Minimal non-validating XML parser producing svgo's AST (xast) for the subset the converter
 * reads: elements, attributes, text, comments, CDATA, processing instructions and a DOCTYPE with
 * internal `<!ENTITY>` declarations. Like svgo (sax in strict + xmlns mode) it fails on
 * mismatched / unclosed tags, unquoted or value-less attributes, unbound namespace prefixes and
 * unknown entities. Known gap: HTML named entities (`&nbsp;`…), which sax accepts, are rejected.
 */
export function parseXml(src: string): XastRoot {
    const root: XastRoot = { type: 'root', children: [] };
    // Open elements; `name` is null for the document root. `ns` holds the bound namespace prefixes.
    const stack: { name: string | null; children: XastNode[]; ns: Set<string> }[] = [
        { name: null, children: root.children, ns: new Set(['xml', 'xmlns']) },
    ];
    const entities = new Map(Object.entries(XML_ENTITIES));
    let pos = 0;

    const fail = (message: string, at = pos): never => {
        throw new XmlError(message, src, at);
    };
    const top = () => stack[stack.length - 1]!; // never empty: root stays at the bottom
    const push = (node: XastNode) => top().children.push(node);
    const until = (marker: string, from: number): number => {
        const end = src.indexOf(marker, from);
        return end === -1 ? fail('Unexpected end', from) : end;
    };

    const decode = (raw: string, at: number, depth = 0): string =>
        raw.includes('&')
            ? raw.replace(ENTITY_REF, (_m, name: string, semi: string) => {
                  if (!semi) return fail('Invalid character in entity name', at);
                  const value = entities.get(name);
                  if (value !== undefined) {
                      if (Object.hasOwn(XML_ENTITIES, name)) return value;
                      if (depth >= MAX_ENTITY_DEPTH) return fail('Parsed entity depth exceeds max entity depth', at);
                      return decode(value, at, depth + 1);
                  }
                  const hex = /^#x([0-9a-f]+)$/i.exec(name);
                  const dec = /^#([0-9]+)$/.exec(name);
                  const code = hex?.[1] ? parseInt(hex[1], 16) : dec?.[1] ? parseInt(dec[1], 10) : NaN;
                  if (!isXmlChar(code)) return fail('Invalid character entity', at);
                  return String.fromCodePoint(code);
              })
            : raw;

    const text = (raw: string, at: number): void => {
        const { name } = top();
        if (name === null) {
            if (raw.trim() !== '') fail('Text data outside of root node.', at);
            return;
        }
        const value = decode(raw, at);
        if (TEXT_ELEMS.has(name)) push({ type: 'text', value });
        else if (value.trim() !== '') push({ type: 'text', value: value.trim() });
    };

    const prefixOf = (name: string): string => (name.includes(':') ? name.slice(0, name.indexOf(':')) : '');

    const openTag = (): void => {
        const nameMatch = /[^\s/>]+/y;
        nameMatch.lastIndex = pos + 1;
        const name = nameMatch.exec(src)?.[0] ?? fail('Invalid tagname');
        pos = nameMatch.lastIndex;
        const attributes: Record<string, string> = {};
        let selfClosing = false;
        for (;;) {
            while (/\s/.test(src[pos] ?? '')) pos++;
            if (pos >= src.length) fail('Unexpected end');
            if (src.startsWith('/>', pos)) {
                selfClosing = true;
                pos += 2;
                break;
            }
            if (src[pos] === '>') {
                pos++;
                break;
            }
            const attrMatch = /[^\s=/>]+/y;
            attrMatch.lastIndex = pos;
            const attr = attrMatch.exec(src)?.[0] ?? fail('Invalid attribute name');
            pos = attrMatch.lastIndex;
            while (/\s/.test(src[pos] ?? '')) pos++;
            if (src[pos] !== '=') fail('Attribute without value');
            pos++;
            while (/\s/.test(src[pos] ?? '')) pos++;
            const quote = src[pos];
            if (quote !== '"' && quote !== "'") return fail('Unquoted attribute value');
            const end = until(quote, pos + 1);
            // Later duplicates win but keep the first position, as with svgo.
            attributes[attr] = decode(src.slice(pos + 1, end), pos);
            pos = end + 1;
        }

        const ns = new Set(top().ns);
        for (const attr of Object.keys(attributes)) if (attr.startsWith('xmlns:')) ns.add(attr.slice(6));
        const elementPrefix = prefixOf(name);
        if (elementPrefix && !ns.has(elementPrefix)) fail(`Unbound namespace prefix: ${JSON.stringify(name)}`);
        for (const attr of Object.keys(attributes)) {
            const prefix = prefixOf(attr);
            if (prefix && prefix !== 'xmlns' && !ns.has(prefix))
                fail(`Unbound namespace prefix: ${JSON.stringify(prefix)}`);
        }

        const children: XastNode[] = [];
        push({ type: 'element', name, attributes, children });
        if (!selfClosing) stack.push({ name, children, ns });
    };

    while (pos < src.length) {
        const lt = src.indexOf('<', pos);
        if (lt === -1) {
            text(src.slice(pos), pos);
            break;
        }
        if (lt > pos) text(src.slice(pos, lt), pos);
        pos = lt;

        if (src.startsWith('<!--', pos)) {
            const end = until('-->', pos + 4);
            push({ type: 'comment', value: src.slice(pos + 4, end).trim() });
            pos = end + 3;
        } else if (src.startsWith('<![CDATA[', pos)) {
            const end = until(']]>', pos + 9);
            push({ type: 'cdata', value: src.slice(pos + 9, end) });
            pos = end + 3;
        } else if (src.slice(pos + 2, pos + 9).toUpperCase() === 'DOCTYPE' && src[pos + 1] === '!') {
            let end = pos + 9;
            for (let depth = 0; end < src.length; end++) {
                if (src[end] === '[') depth++;
                else if (src[end] === ']') depth--;
                else if (src[end] === '>' && depth <= 0) break;
            }
            if (end >= src.length) fail('Unexpected end');
            const doctype = src.slice(pos + 9, end);
            push({ type: 'doctype', name: 'svg', data: { doctype } });
            for (const [, name = '', single, double] of doctype.matchAll(ENTITY_DECLARATION))
                entities.set(name, single ?? double ?? '');
            pos = end + 1;
        } else if (src.startsWith('<?', pos)) {
            const end = until('?>', pos + 2);
            const body = src.slice(pos + 2, end);
            const name = /^[^\s]*/.exec(body)![0];
            push({ type: 'instruction', name, value: body.slice(name.length).replace(/^\s+/, '') });
            pos = end + 2;
        } else if (src[pos + 1] === '!') {
            pos = until('>', pos) + 1; // other SGML declarations: ignored, as by svgo
        } else if (src[pos + 1] === '/') {
            const end = until('>', pos);
            const name = src.slice(pos + 2, end).trim();
            if (top().name !== name) fail(`Unmatched closing tag: ${name}`);
            stack.pop();
            pos = end + 1;
        } else {
            openTag();
        }
    }
    if (stack.length > 1) fail('Unclosed root tag');
    return root;
}

/** CSS named colors, identical to svgo's `_collections.colorsNames` (asserted by tests). */
const colorsNames: Record<string, string> = {
    aliceblue: '#f0f8ff',
    antiquewhite: '#faebd7',
    aqua: '#0ff',
    aquamarine: '#7fffd4',
    azure: '#f0ffff',
    beige: '#f5f5dc',
    bisque: '#ffe4c4',
    black: '#000',
    blanchedalmond: '#ffebcd',
    blue: '#00f',
    blueviolet: '#8a2be2',
    brown: '#a52a2a',
    burlywood: '#deb887',
    cadetblue: '#5f9ea0',
    chartreuse: '#7fff00',
    chocolate: '#d2691e',
    coral: '#ff7f50',
    cornflowerblue: '#6495ed',
    cornsilk: '#fff8dc',
    crimson: '#dc143c',
    cyan: '#0ff',
    darkblue: '#00008b',
    darkcyan: '#008b8b',
    darkgoldenrod: '#b8860b',
    darkgray: '#a9a9a9',
    darkgreen: '#006400',
    darkgrey: '#a9a9a9',
    darkkhaki: '#bdb76b',
    darkmagenta: '#8b008b',
    darkolivegreen: '#556b2f',
    darkorange: '#ff8c00',
    darkorchid: '#9932cc',
    darkred: '#8b0000',
    darksalmon: '#e9967a',
    darkseagreen: '#8fbc8f',
    darkslateblue: '#483d8b',
    darkslategray: '#2f4f4f',
    darkslategrey: '#2f4f4f',
    darkturquoise: '#00ced1',
    darkviolet: '#9400d3',
    deeppink: '#ff1493',
    deepskyblue: '#00bfff',
    dimgray: '#696969',
    dimgrey: '#696969',
    dodgerblue: '#1e90ff',
    firebrick: '#b22222',
    floralwhite: '#fffaf0',
    forestgreen: '#228b22',
    fuchsia: '#f0f',
    gainsboro: '#dcdcdc',
    ghostwhite: '#f8f8ff',
    gold: '#ffd700',
    goldenrod: '#daa520',
    gray: '#808080',
    green: '#008000',
    greenyellow: '#adff2f',
    grey: '#808080',
    honeydew: '#f0fff0',
    hotpink: '#ff69b4',
    indianred: '#cd5c5c',
    indigo: '#4b0082',
    ivory: '#fffff0',
    khaki: '#f0e68c',
    lavender: '#e6e6fa',
    lavenderblush: '#fff0f5',
    lawngreen: '#7cfc00',
    lemonchiffon: '#fffacd',
    lightblue: '#add8e6',
    lightcoral: '#f08080',
    lightcyan: '#e0ffff',
    lightgoldenrodyellow: '#fafad2',
    lightgray: '#d3d3d3',
    lightgreen: '#90ee90',
    lightgrey: '#d3d3d3',
    lightpink: '#ffb6c1',
    lightsalmon: '#ffa07a',
    lightseagreen: '#20b2aa',
    lightskyblue: '#87cefa',
    lightslategray: '#789',
    lightslategrey: '#789',
    lightsteelblue: '#b0c4de',
    lightyellow: '#ffffe0',
    lime: '#0f0',
    limegreen: '#32cd32',
    linen: '#faf0e6',
    magenta: '#f0f',
    maroon: '#800000',
    mediumaquamarine: '#66cdaa',
    mediumblue: '#0000cd',
    mediumorchid: '#ba55d3',
    mediumpurple: '#9370db',
    mediumseagreen: '#3cb371',
    mediumslateblue: '#7b68ee',
    mediumspringgreen: '#00fa9a',
    mediumturquoise: '#48d1cc',
    mediumvioletred: '#c71585',
    midnightblue: '#191970',
    mintcream: '#f5fffa',
    mistyrose: '#ffe4e1',
    moccasin: '#ffe4b5',
    navajowhite: '#ffdead',
    navy: '#000080',
    oldlace: '#fdf5e6',
    olive: '#808000',
    olivedrab: '#6b8e23',
    orange: '#ffa500',
    orangered: '#ff4500',
    orchid: '#da70d6',
    palegoldenrod: '#eee8aa',
    palegreen: '#98fb98',
    paleturquoise: '#afeeee',
    palevioletred: '#db7093',
    papayawhip: '#ffefd5',
    peachpuff: '#ffdab9',
    peru: '#cd853f',
    pink: '#ffc0cb',
    plum: '#dda0dd',
    powderblue: '#b0e0e6',
    purple: '#800080',
    rebeccapurple: '#639',
    red: '#f00',
    rosybrown: '#bc8f8f',
    royalblue: '#4169e1',
    saddlebrown: '#8b4513',
    salmon: '#fa8072',
    sandybrown: '#f4a460',
    seagreen: '#2e8b57',
    seashell: '#fff5ee',
    sienna: '#a0522d',
    silver: '#c0c0c0',
    skyblue: '#87ceeb',
    slateblue: '#6a5acd',
    slategray: '#708090',
    slategrey: '#708090',
    snow: '#fffafa',
    springgreen: '#00ff7f',
    steelblue: '#4682b4',
    tan: '#d2b48c',
    teal: '#008080',
    thistle: '#d8bfd8',
    tomato: '#ff6347',
    turquoise: '#40e0d0',
    violet: '#ee82ee',
    wheat: '#f5deb3',
    white: '#fff',
    whitesmoke: '#f5f5f5',
    yellow: '#ff0',
    yellowgreen: '#9acd32',
};

export const _collections = { colorsNames, textElems: TEXT_ELEMS };
