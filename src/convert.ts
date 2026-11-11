import type { XastElement } from './ast.js';
import { ClipPaths } from './clip.js';
import type { ConvertContext } from './context.js';
import { collectByName, failsConditions } from './elements.js';
import { colorRefs } from './colorRef.js';
import { ConversionError } from './errors.js';
import { escapeXml, formatNumber } from './format.js';
import { collectGradients } from './gradient.js';
import { checkGroupOpacity } from './groupOpacity.js';
import { initialStyle, resolveStyle } from './inherited.js';
import { parseSvg } from './normalize.js';
import { walk } from './render.js';
import { applyCssProperties, parseStyle, presentation } from './style.js';
import { parseOpacity } from './units.js';
import { resolveUses } from './useResolver.js';
import { formatMatrix } from './transform.js';
import { layoutWarnings, rootLayout, rootTransform } from './viewport.js';
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
/** Upper bound of `floatPrecision`: beyond it a double carries no further decimal. */
const MAX_FLOAT_PRECISION = 20;
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

interface Size {
    width: number;
    height: number;
}

/**
 * `android:width` / `android:height` (dp): the `width` / `height` options, else the SVG's size. One
 * option alone scales the other dimension by the SVG size's aspect ratio (not the viewport's: under
 * `preserveAspectRatio="none"` they differ, and the size is what the drawing is stretched to).
 */
export function vectorSize(svgSize: Size, width: number | undefined, height: number | undefined): Size {
    const ratio = svgSize.width / svgSize.height;
    return {
        width: width ?? (height === undefined ? svgSize.width : height * ratio),
        height: height ?? (width === undefined ? svgSize.height : width / ratio),
    };
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
        autoMirrored = false,
        onWarn,
        minSdk: appMinSdk,
    } = options;

    if (strict !== true && strict !== false && strict !== 'lossy')
        throw new TypeError(`Invalid strict: ${JSON.stringify(strict)} (expected true, false or 'lossy')`);
    if (appMinSdk !== undefined && !(Number.isInteger(appMinSdk) && appMinSdk >= 1))
        throw new TypeError(`Invalid minSdk: ${appMinSdk} (expected a positive integer)`);
    if (!(Number.isInteger(floatPrecision) && floatPrecision >= 0 && floatPrecision <= MAX_FLOAT_PRECISION))
        throw new TypeError(
            `Invalid floatPrecision: ${floatPrecision} (expected an integer from 0 to ${MAX_FLOAT_PRECISION})`,
        );
    if (!(Number.isInteger(indent) && indent >= 0))
        throw new TypeError(`Invalid indent: ${indent} (expected a non-negative integer)`);
    for (const name of ['width', 'height'] as const) {
        const dp = options[name];
        if (dp !== undefined && !(Number.isFinite(dp) && dp > 0))
            throw new TypeError(`Invalid ${name}: ${dp} (expected a finite number of dp greater than 0)`);
    }
    // `currentColor` (a CSS color or an Android reference) and `colorMap` are validated here (TypeError).
    const colors = colorRefs(currentColor, options.colorMap, (w) => warn(w));

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

    const root = parseSvg(svg, optimize, svgoConfig, floatPrecision, fillBlackForUnfilled);
    // Fold CSS transforms into attributes before <use> expansion, so that clones inherit them.
    applyCssProperties(root, warn);
    resolveUses(root); // inline <use> references so the walker sees concrete geometry
    const found = (root.children ?? []).find((c) => c.type === 'element' && c.name === 'svg');
    if (!found) throw new Error('No <svg> root element found');
    // Conditional processing (SVG 2 §5.8) applies to the root too: when it fails, browsers render
    // nothing, so the <vector> is emptied (still a valid drawable); being lossy, strict rejects it.
    const excluded = failsConditions(found);
    if (excluded)
        warn({
            code: 'unsupported-attribute',
            message:
                'The root <svg> fails its requiredExtensions / systemLanguage condition: nothing is rendered; the <vector> is empty.',
            node: 'svg',
        });
    else if (found.attributes?.systemLanguage !== undefined)
        warn({
            code: 'unsupported-attribute',
            message:
                'systemLanguage on <svg> depends on the device language, which a VectorDrawable cannot test; ignored.',
            node: 'svg',
        });
    const svgEl: XastElement = excluded ? { ...found, children: [] } : found;

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
    // No size and no viewBox: the size is undefined (browsers use 300×150, resvg the content bounds).
    // Guessing from the content would not match any renderer either; report the crop instead.
    if (layout.assumed.length)
        warn({
            code: 'unsupported-attribute',
            message: `The root <svg> has no viewBox and no usable ${layout.assumed.join(' / ')}: its size is undefined; assumed 24, content beyond it is cropped. Add a viewBox.`,
            node: 'svg',
        });
    // Only the transform attribute is read: a CSS one on the root would be silently dropped.
    if (['transform', 'transform-origin'].some((p) => parseStyle(svgEl.attributes?.style)[p] !== undefined))
        warn({
            code: 'unsupported-style',
            message: 'CSS transform / transform-origin on the root <svg> is not supported; ignored.',
            node: 'svg',
        });
    // Viewport-relative units on an <svg>, a root transform-origin that cannot be resolved.
    for (const w of layoutWarnings(svgEl)) warn(w);
    const step = ' '.repeat(indent);
    const r = (v: number): string => formatNumber(v, floatPrecision);

    const gradientEls = elementsNamed(svgEl, 'linearGradient', 'radialGradient');
    const ctx: ConvertContext = {
        warn,
        precision: floatPrecision,
        step,
        fillBlackForUnfilled,
        colors,
        gradients: collectGradients(gradientEls, currentColor, warn, colors, svgEl),
        gradientIds: new Set(gradientEls.map((g) => g.attributes?.id)),
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
    // A root transform (SVG 2) wraps the content in a <g> that also carries that offset.
    const rootMatrix = rootTransform(svgEl.attributes ?? {}, layout);
    const tx = rootMatrix ? 0 : layout.offsetX;
    const ty = rootMatrix ? 0 : layout.offsetY;
    const offset = Math.abs(tx) > 1e-9 || Math.abs(ty) > 1e-9;
    const rendered: XastElement = rootMatrix
        ? {
              ...svgEl,
              children: [
                  {
                      type: 'element',
                      name: 'g',
                      attributes: { transform: formatMatrix(rootMatrix) },
                      children: svgEl.children ?? [],
                  },
              ],
          }
        : svgEl;
    const content = walk(ctx, rendered, baseStyle, offset ? step + step : step);
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
    const mirrorLine = autoMirrored ? `\n${step}android:autoMirrored="true"` : '';
    // The width / height options resize the drawable only: the viewport (the content's coordinates) stays.
    const size = vectorSize(layout, options.width, options.height);
    const decl = xmlTag ? '<?xml version="1.0" encoding="utf-8"?>\n' : '';
    const xml =
        decl +
        `<vector xmlns:android="http://schemas.android.com/apk/res/android"${aapt}${tintLine}${alphaLine}${mirrorLine}\n` +
        `${step}android:width="${r(size.width)}dp"\n` +
        `${step}android:height="${r(size.height)}dp"\n` +
        `${step}android:viewportWidth="${r(layout.viewportWidth)}"\n` +
        `${step}android:viewportHeight="${r(layout.viewportHeight)}">\n` +
        `${body}\n` +
        `</vector>\n`;

    // Android-side checks on the generated XML (what the app ships), after the conversion itself.
    if (size.width > MAX_VECTOR_DP || size.height > MAX_VECTOR_DP)
        warn({
            code: 'large-vector',
            message: `Vector size ${r(size.width)}×${r(size.height)}dp exceeds ${MAX_VECTOR_DP}dp; large vectors are slow to render (prefer a bitmap for big artwork).`,
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
