import { ClipPaths } from './clip.js';
import type { ConvertContext } from './context.js';
import { collectByName } from './elements.js';
import { ConversionError } from './errors.js';
import { escapeXml, formatNumber } from './format.js';
import { collectGradients, type XastElement } from './gradient.js';
import { checkGroupOpacity } from './groupOpacity.js';
import { initialStyle, resolveStyle } from './inherited.js';
import { parseSvg } from './normalize.js';
import { walk } from './render.js';
import { presentation } from './style.js';
import { parseOpacity } from './units.js';
import { resolveUses } from './useResolver.js';
import { rootLayout } from './viewport.js';
import {
    WARNING_CATEGORIES,
    WARNING_CODES,
    type ConvertOptions,
    type ConvertResult,
    type Severity,
    type StrictMode,
    type Warning,
    type WarningCode,
} from './types.js';

/** VectorDrawable itself: API 21. */
const BASE_SDK = 21;
/** `<aapt:attr>` gradient colors and `android:fillType` (framework VectorDrawable): API 24. */
const GRADIENT_FILL_TYPE_SDK = 24;
/** Android lint `VectorPath` threshold (characters of one `pathData`). */
const MAX_PATH_DATA_LENGTH = 800;
/** Android's recommended maximum vector size (dp). */
const MAX_VECTOR_DP = 200;
/** `info` codes too noisy to report unless enabled with `rules` (`long-path-data`: ~3% of real icons). */
const OFF_BY_DEFAULT: ReadonlySet<WarningCode> = new Set(['long-path-data']);

/** Severity of `code` before `rules`: `strict` escalates `lossy` (and `approximation` for `true`). */
function defaultSeverity(code: WarningCode, strict: StrictMode): Severity {
    const category = WARNING_CATEGORIES[code];
    if (category === 'info') return OFF_BY_DEFAULT.has(code) ? 'off' : 'warn';
    if (strict === true || (strict === 'lossy' && category === 'lossy')) return 'error';
    return 'warn';
}

/** Features of the generated XML that need more than API 21, with the level they need. */
function apiRequirements(xml: string): { feature: string; sdk: number }[] {
    const out: { feature: string; sdk: number }[] = [];
    if (/<gradient\b/.test(xml))
        out.push({ feature: 'gradient fill/stroke (<aapt:attr> complex color)', sdk: GRADIENT_FILL_TYPE_SDK });
    if (/android:fillType=/.test(xml)) out.push({ feature: 'android:fillType', sdk: GRADIENT_FILL_TYPE_SDK });
    return out;
}

/** Text content of an element (`<style>` CSS), comments stripped. */
const cssText = (el: XastElement): string =>
    (el.children ?? [])
        .map((c) => (c as { value?: string }).value ?? '')
        .join('')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

const elementsNamed = (root: XastElement, ...names: string[]): XastElement[] => {
    const out: XastElement[] = [];
    collectByName(root, new Set(names), out);
    return out;
};

export function convert(svg: string, options: ConvertOptions = {}): ConvertResult {
    const {
        optimize = true,
        svgoConfig,
        floatPrecision = 3,
        currentColor = '#000000',
        fillBlackForUnfilled = true,
        strict = false,
        rules = {},
        indent = 4,
        xmlTag = false,
        tint,
        onWarn,
        minSdk: appMinSdk,
    } = options;

    if (strict !== true && strict !== false && strict !== 'lossy')
        throw new TypeError(`Invalid strict: ${JSON.stringify(strict)} (expected true, false or 'lossy')`);
    if (appMinSdk !== undefined && !(Number.isInteger(appMinSdk) && appMinSdk >= 1))
        throw new TypeError(`Invalid minSdk: ${appMinSdk} (expected a positive integer)`);

    for (const code of Object.keys(rules))
        if (!(WARNING_CODES as readonly string[]).includes(code))
            throw new TypeError(`Unknown warning code in rules: "${code}"`);

    const warnings: Warning[] = [];
    const severityOf = (code: WarningCode): Severity => rules[code] ?? defaultSeverity(code, strict);
    const warn = (w: Warning): void => {
        const severity = severityOf(w.code);
        if (severity === 'off') return;
        if (severity === 'error') throw new ConversionError(w);
        warnings.push(w);
        onWarn?.(w);
    };

    const root = parseSvg(svg, optimize, svgoConfig);
    resolveUses(root); // inline <use> references so the walker sees concrete geometry
    const svgEl = (root.children ?? []).find((c) => c.type === 'element' && c.name === 'svg');
    if (!svgEl) throw new Error('No <svg> root element found');

    // svgo inlines what it can and drops the emptied <style>; any CSS left was not applied.
    if (elementsNamed(svgEl, 'style').some((s) => cssText(s) !== ''))
        warn({
            code: 'unsupported-style',
            message: optimize
                ? 'CSS rules in <style> could not be inlined (@media, pseudo-classes or complex selectors); ignored.'
                : 'CSS in <style> is not applied with optimize:false (svgo inlines it); ignored.',
            node: 'style',
        });

    const layout = rootLayout(svgEl.attributes ?? {});
    const step = ' '.repeat(indent);
    const r = (v: number): string => formatNumber(v, floatPrecision);

    const ctx: ConvertContext = {
        warn,
        precision: floatPrecision,
        step,
        fillBlackForUnfilled,
        gradients: collectGradients(elementsNamed(svgEl, 'linearGradient', 'radialGradient'), currentColor, warn),
        patternIds: new Set(
            elementsNamed(svgEl, 'pattern')
                .map((p) => p.attributes?.id)
                .filter(Boolean),
        ),
        clips: new ClipPaths(svgEl, warn, layout.viewBox, floatPrecision),
        reported: new WeakSet(),
        usesGradient: false,
    };

    const rootStyle = initialStyle(currentColor, layout.viewBox);
    // Presentation attributes (fill/stroke/stroke-width…) set on the <svg> element itself are
    // inherited by its children (e.g. Feather/Bootstrap icons put stroke/fill on the root).
    // Opacity on the root is exactly android:alpha on the <vector>; no need to fold it.
    const rootAlpha = parseOpacity(presentation(svgEl, 'opacity'));
    const baseStyle = { ...resolveStyle(svgEl, rootStyle), opacityMul: 1 };
    checkGroupOpacity(ctx, { ...svgEl, attributes: { ...svgEl.attributes, opacity: '1' } }, rootStyle);

    // A viewBox origin other than (0,0) (or an aspect-ratio alignment) shifts the whole drawing;
    // VectorDrawable viewports always start at (0,0), so translate the content into place.
    const { offsetX: tx, offsetY: ty } = layout;
    const offset = Math.abs(tx) > 1e-9 || Math.abs(ty) > 1e-9;
    const content = walk(ctx, svgEl, baseStyle, offset ? step + step : step);
    const offsetAttrs = [
        Math.abs(tx) > 1e-9 ? `${step}${step}android:translateX="${r(tx)}"` : null,
        Math.abs(ty) > 1e-9 ? `${step}${step}android:translateY="${r(ty)}"` : null,
    ].filter(Boolean);
    const body =
        offset && content.trim() ? `${step}<group\n${offsetAttrs.join('\n')}>\n${content}\n${step}</group>` : content;

    const aapt = ctx.usesGradient ? `\n${step}xmlns:aapt="http://schemas.android.com/aapt"` : '';
    // tint is an Android color literal (#AARRGGBB), not an SVG color — pass it through verbatim.
    const tintLine = tint ? `\n${step}android:tint="${escapeXml(tint.trim())}"` : '';
    const alphaLine = rootAlpha < 1 ? `\n${step}android:alpha="${rootAlpha}"` : '';
    const decl = xmlTag ? '<?xml version="1.0" encoding="utf-8"?>\n' : '';
    const xml =
        decl +
        `<vector xmlns:android="http://schemas.android.com/apk/res/android"${aapt}${tintLine}${alphaLine}\n` +
        `${step}android:width="${r(layout.width)}dp"\n` +
        `${step}android:height="${r(layout.height)}dp"\n` +
        `${step}android:viewportWidth="${r(layout.viewportWidth)}"\n` +
        `${step}android:viewportHeight="${r(layout.viewportHeight)}">\n` +
        `${body}\n` +
        `</vector>\n`;

    // Android-side checks on the generated XML (what the app ships), after the conversion itself.
    if (layout.width > MAX_VECTOR_DP || layout.height > MAX_VECTOR_DP)
        warn({
            code: 'large-vector',
            message: `Vector size ${r(layout.width)}×${r(layout.height)}dp exceeds ${MAX_VECTOR_DP}dp; large vectors are slow to render (prefer a bitmap for big artwork).`,
            node: 'vector',
        });
    if (severityOf('long-path-data') !== 'off') {
        const long = [...xml.matchAll(/android:pathData="([^"]*)"/g)]
            .map((m) => m[1]!.length)
            .filter((n) => n > MAX_PATH_DATA_LENGTH);
        if (long.length)
            warn({
                code: 'long-path-data',
                message: `${long.length} pathData longer than ${MAX_PATH_DATA_LENGTH} characters (longest: ${Math.max(...long)}); slow to render, consider simplifying the shape.`,
                node: 'path',
            });
    }
    const requirements = apiRequirements(xml);
    const needed = Math.max(BASE_SDK, ...requirements.map((q) => q.sdk));
    if (appMinSdk !== undefined && needed > appMinSdk)
        warn({
            code: 'min-sdk-exceeded',
            message: `Output needs API ${needed} (minSdk ${appMinSdk}): ${requirements
                .filter((q) => q.sdk > appMinSdk)
                .map((q) => `${q.feature} requires API ${q.sdk}`)
                .join('; ')}. Below it, use AppCompat's VectorDrawableCompat (vectorDrawables.useSupportLibrary).`,
            node: 'vector',
        });

    return { xml, warnings, minSdk: needed };
}
