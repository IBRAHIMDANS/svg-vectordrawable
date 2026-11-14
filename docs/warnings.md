# Warnings: what they mean and how to fix them

`svg-vectordrawable` never drops part of an SVG silently: whatever it cannot convert exactly comes
with a warning. Each warning has a stable `code` and a category:

| Category          | Meaning                                                                | Under `strict: true` | Under `strict: 'lossy'` |
| ----------------- | ---------------------------------------------------------------------- | -------------------- | ----------------------- |
| **lossy**         | Part of the SVG is missing from the drawable, or drawn wrong           | error                | error                   |
| **approximation** | Everything is drawn, but the result differs slightly from the SVG      | error                | warning                 |
| **info**          | The drawable is faithful; advice about Android (API level, size, lint) | warning              | warning                 |

Most warnings are fixed **in the SVG**, usually in the design tool before exporting: outline a
stroke or a text, flatten an effect, export with presentation attributes. When a file cannot become a
vector at all (a photo, a blur), the command line can write a PNG instead with
[`--fallback-png`](../README.md#png-fallback).

To change how a code is treated, set its severity with `rules` (API) or `--rule` (CLI): `off` drops
it, `warn` reports it, `error` rejects the file.

```ts
convert(svg, { strict: true, rules: { 'opacity-approximated': 'warn', 'large-vector': 'off' } });
```

```sh
svgvd icons/ -o res/drawable --strict --rule opacity-approximated=warn --rule large-vector=off
```

| Code                                                            | Category      | Default |
| --------------------------------------------------------------- | ------------- | ------- |
| [`unsupported-element`](#unsupported-element)                   | lossy         | on      |
| [`unsupported-attribute`](#unsupported-attribute)               | lossy         | on      |
| [`unsupported-stroke-dasharray`](#unsupported-stroke-dasharray) | lossy         | on      |
| [`unsupported-stroke-gradient`](#unsupported-stroke-gradient)   | lossy         | unused  |
| [`unsupported-paint`](#unsupported-paint)                       | lossy         | on      |
| [`unsupported-color-reference`](#unsupported-color-reference)   | lossy         | on      |
| [`unsupported-clip-path`](#unsupported-clip-path)               | lossy         | on      |
| [`unsupported-style`](#unsupported-style)                       | lossy         | on      |
| [`missing-gradient`](#missing-gradient)                         | lossy         | on      |
| [`missing-clip-path`](#missing-clip-path)                       | lossy         | on      |
| [`empty-path`](#empty-path)                                     | lossy         | on      |
| [`opacity-approximated`](#opacity-approximated)                 | approximation | on      |
| [`gradient-approximated`](#gradient-approximated)               | approximation | on      |
| [`mask-approximated`](#mask-approximated)                       | approximation | on      |
| [`group-skew`](#group-skew)                                     | approximation | on      |
| [`gradient-under-skew`](#gradient-under-skew)                   | approximation | on      |
| [`gradient-bbox-unavailable`](#gradient-bbox-unavailable)       | approximation | on      |
| [`min-sdk-exceeded`](#min-sdk-exceeded)                         | info          | on      |
| [`large-vector`](#large-vector)                                 | info          | on      |
| [`long-path-data`](#long-path-data)                             | info          | off     |
| [`invalid-path-data`](#invalid-path-data)                       | info          | off     |

## Lossy

### `unsupported-element`

An element a VectorDrawable cannot draw is skipped: `<text>`, `<image>`, `<foreignObject>`, or a `<use>`
that points at its own ancestor (a circular reference, which browsers do not draw either).

> `<text> cannot be represented in a VectorDrawable; skipped.`

How to fix:

- **Text**: convert it to outlines in the design tool (Figma: _Outline stroke_ / _Flatten_; Illustrator:
  _Type → Create Outlines_; Inkscape: _Path → Object to Path_). Or, with the package, pass the font
  file: `fonts: { Inter: 'Inter.ttf' }` / `--font Inter=Inter.ttf` draws a simple line of text as paths.
- **Image** (`<image>`, an embedded photo or bitmap): it has no vector form. Ship it as a PNG or WebP
  drawable, or let the CLI write one with `--fallback-png`.

### `unsupported-attribute`

An attribute with no VectorDrawable equivalent is ignored: `filter` (blur, shadow), `marker-*`
(arrowheads), a `mask` that is not a clip, `vector-effect`, `paint-order`, `stroke-linejoin="arcs"`.

> `filter on <rect> cannot be represented in a VectorDrawable; ignored.`

How to fix:

- **Shadows and blurs**: remove them from the icon and use Android's own (`elevation`, a shadow drawable),
  or ship that asset as a PNG (`--fallback-png`).
- **Markers**: in the design tool, expand the arrowheads into shapes (_Outline stroke_, _Expand
  appearance_).
- **`paint-order: stroke`** (stroke under the fill): outline the stroke into a shape placed under the fill.

### `unsupported-stroke-dasharray`

A dash pattern that cannot be resolved (font-relative units such as `ex`, `em`, a `calc()`) is dropped:
the stroke is drawn solid. Other dash patterns are converted, each dash becoming a piece of path.

> `stroke-dasharray="1ex" could not be converted to dash geometry; the stroke is drawn solid.`

How to fix: write the pattern in plain numbers (`stroke-dasharray="4 2"`).

### `unsupported-stroke-gradient`

No longer emitted: gradient strokes are converted. The code is kept so that existing `rules` stay valid.

### `unsupported-paint`

A paint the drawable cannot express or the converter cannot read: a `<pattern>` fill (not painted, or
its fallback color), a `fill` / `stroke` / `stop-color` value that is not a color, `context-fill` /
`context-stroke` outside a `<use>`.

> `<pattern> fill "p" cannot be represented in a VectorDrawable; the fill is not painted.`

How to fix:

- **Pattern**: replace it with the shapes it repeats, or ship the asset as a bitmap.
- **Unreadable color**: correct the value (`fill="#1A73E8"`, `rgb()`, `hsl()` and CSS names all work).

### `unsupported-color-reference`

A theme color you asked for (`currentColor: '?attr/colorPrimary'`, `colorMap`) cannot be written where
it is used:

- on a **translucent gradient stop**: a gradient `<item>` has no alpha attribute, so the literal color
  is kept and that stop does not follow the theme;
- in a **Compose `ImageVector`**, which has no app resources: the reference is drawn in gray
  (`#FF808080`).

> `Gradient "g" has a translucent stop mapped to ?attr/colorPrimary: a gradient <item> has no alpha, so the literal #80000000 is kept and does not follow the theme.`

How to fix: make that stop opaque, or keep a literal color for it. In Compose, use a literal color
and tint the `Icon` where it is drawn (`tint = MaterialTheme.colorScheme.primary`).

### `unsupported-clip-path`

A `clip-path` that cannot be converted (fully) is ignored: a `clipPathUnits="objectBoundingBox"` clip, an
even-odd clip whose contours cross, clip content that is not a shape (`<text>`), a CSS shape it cannot
lay out (`inset(… round …)`, `path()`).

> `<text> inside a <clipPath> cannot be converted; ignored.`

How to fix: in the design tool, turn the clip content into plain shapes (outline text, flatten), or
apply the clip to the shapes themselves (a boolean _intersect_), so no clip is needed.

### `unsupported-style`

CSS in a `<style>` element that could not be applied to the elements is ignored: `@media`, `:hover`,
complex selectors. With `optimize: false` (and on the online playground, which uses the lightweight
build), **no** `<style>` rule is applied at all.

> `CSS rules in <style> could not be inlined (@media, pseudo-classes or complex selectors); ignored.`

How to fix:

- Export with **presentation attributes** instead of a style sheet (Illustrator: _Export As → SVG →
  Styling: Presentation Attributes_; Figma and Inkscape write attributes already).
- Use the package or the CLI with the default `optimize: true`, which inlines simple rules.
- Move the rule into the elements: `<rect style="fill:#1A73E8">` or `fill="#1A73E8"`.

### `missing-gradient`

A `fill` or `stroke` of `url(#id)` that cannot be painted: the id points at nothing, at an invalid
gradient, or at a gradient without any `<stop>`.

> `fill="url(#nope)" points at nothing (unknown paint server), without fallback color; the fill is not painted.`

How to fix: check that the gradient is in the file (copying a layer out of a design tool can leave its
`<defs>` behind), that the id matches, and that it has stops. A fallback color is used when given:
`fill="url(#g) #1A73E8"`.

### `missing-clip-path`

A `clip-path="url(#id)"` whose id points at nothing is ignored: the element is drawn unclipped.

> `Unknown clip-path "nope"; ignored.`

How to fix: export the `<clipPath>` with the shape, or correct the id.

### `empty-path`

A shape without geometry is skipped: a `<rect>` of width 0, a `<path>` without `d`, a `<polygon>` whose
`points` are in error, a number beyond the float range.

> `<rect> produced no drawable geometry; skipped.`

How to fix: usually nothing is lost (browsers draw nothing for it either), so delete the empty
element from the file. If you expected a shape, check its size and its path data.

## Approximation

### `opacity-approximated`

A group's `opacity` has no VectorDrawable equivalent: it is applied to each child instead, which is
exact only when the children do not overlap. Where they overlap, the result looks darker than in the
SVG. The same holds for one shape with both a fill and a stroke.

> `Group opacity is folded onto overlapping children; overlaps will render darker than in the SVG.`

How to fix: merge the overlapping shapes into one (boolean _union_, _Flatten_) before setting the
opacity, or set the opacity on non-overlapping pieces only. The opacity of the root `<svg>` is exact
(`android:alpha`). If the difference is acceptable, keep the conversion strict but allow it:
`--rule opacity-approximated=warn`.

### `gradient-approximated`

A gradient the drawable can only approximate: a radial gradient's focal point (`fx` / `fy`, centered on
`cx` / `cy` instead); an elliptical radial gradient on a path that also has a solid stroke; a
`color-interpolation="linearRGB"` gradient that would need over 64 stops; a linear gradient with a
degenerate `gradientTransform`.

> `Radial gradient focal point (fx/fy) is not supported; centered on cx/cy.`

How to fix: remove the focal point; put the stroke on its own path (an elliptical radial on a fill
alone is exact); use the default `sRGB` interpolation.

### `mask-approximated`

A `<mask>` converted to a clip-path ignores the stroke of its content, since a clip-path has no stroke:
the masked area differs along the stroked outlines.

> `mask "m": the stroke of its content is ignored (a clip-path draws no stroke); the masked area differs along the stroked outlines.`

How to fix: outline the strokes inside the mask (_Outline stroke_) so the mask content is filled shapes.

### `group-skew`

A group with a skew or shear cannot be an Android `<group>`: its transform is baked into the paths.
Fills stay exact; a stroke keeps a uniform width, where the SVG would shear it.

> `A <g> uses skew/shear; baking the transform into path geometry.`

How to fix: outline the stroke in the design tool before skewing, or remove the skew.

### `gradient-under-skew`

A gradient inside a skewed group, once the skew is baked into the paths, may be slightly off.

> `Gradient under a skewed/baked group may be imprecisely placed.`

How to fix: apply the skew to the shape in the design tool (so the export has no skewed group), or
remove it.

### `gradient-bbox-unavailable`

A gradient in `objectBoundingBox` units (the SVG default) is laid out on the shape's bounding box; when
that box cannot be measured, the viewport is used instead.

> `objectBoundingBox gradient could not use the path bounding box; approximated to the viewport.`

How to fix: export the gradient with `gradientUnits="userSpaceOnUse"`, or check the shape's path data.

## Info

### `min-sdk-exceeded`

Only checked when you give your app's `minSdk` (`minSdk: 21`, `--min-sdk 21`). The drawable needs a
higher API level: gradients and `android:fillType="evenOdd"` need API 24. An even-odd fill whose contours
are nested or apart (a ring, a target) is already rewritten for API 21; only crossing contours keep
`evenOdd`.

> `Output needs API 24 (minSdk 21): gradient fill/stroke (<aapt:attr> complex color) requires API 24. Below it, use AppCompat's VectorDrawableCompat (vectorDrawables.useSupportLibrary).`

How to fix: below API 24, enable AppCompat's vector support and use `app:srcCompat`:

```kotlin
// app/build.gradle.kts
android { defaultConfig { vectorDrawables.useSupportLibrary = true } }
```

```xml
<ImageView app:srcCompat="@drawable/icon" … />
```

### `large-vector`

`android:width` or `android:height` above 200 dp. Android rasterizes a vector each time it draws it at
a new size: large ones are slow and use memory (Android lint `VectorRaster`).

> `Vector size 300×300dp exceeds 200dp; large vectors are slow to render (prefer a bitmap for big artwork).`

How to fix: if it is an icon, give it its display size (`width: 24` / `--width 24`, the viewport is
kept). If it is a big illustration, a WebP or PNG is usually the better format.

### `long-path-data`

Off by default (`rules: { 'long-path-data': 'warn' }`). A `pathData` longer than 800 characters (Android
lint `VectorPath`) is slower to parse and draw.

> `1 pathData longer than 800 characters (longest: 1044); slow to render, consider simplifying the shape.`

How to fix: simplify the shape in the design tool (fewer points), or lower `floatPrecision` (2 is
plenty for a 24 dp icon).

### `invalid-path-data`

Off by default (`rules: { 'invalid-path-data': 'warn' }`). A `<path>` whose `d` has an error after a
valid start (a typo): it is drawn up to its last valid segment, as browsers do, and the rest is ignored.

> `<path> d has an error at character 12 ("x 3 3"): drawn up to its last valid segment, as browsers do; the rest is ignored.`

How to fix: correct the path data at the reported character, or re-export the shape.
