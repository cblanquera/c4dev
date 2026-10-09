---
name: chrisai-iconography
description: Use for creating, extending, auditing, or packaging cohesive UI icon systems and original SVG interface icons. Excludes logos, favicons, emoji, and decorative illustration.
license: MIT
---

# ChrisAI Iconography

Use this skill for interface iconography whose quality depends on semantic
clarity, consistent family geometry, exact vector construction, and review at
the sizes where the icons will actually appear.

This skill owns original UI icons, related icon families, icon-system
specifications, icon audits, SVG masters, usage metadata, and review artifacts.
It does not own logos, favicons, app-store icons, emoji, spot illustrations,
decorative graphics, or general screen design.

## Core Contract

- Inspect the product's existing icons, components, tokens, naming, and source
  files before introducing a new visual language.
- Prefer an existing icon when it expresses the intended concept and fits the
  accepted system. Do not create a near-duplicate merely for novelty.
- Separate what an icon depicts from what an interface uses it to mean. Keep
  the visual name stable and record contextual meanings as use cases.
- Define or recover the icon-system profile before producing a family. Cover
  grid, live area, keylines, construction style, stroke or fill rules, caps,
  joins, corners, spacing, optical corrections, modifiers, naming, and output
  formats.
- Default original UI icons to monochrome: one foreground color plus negative
  space. Use `currentColor` unless the accepted system requires another token.
  Use duotone or multicolor only when the existing system or user explicitly
  requires it.
- Use editable vector geometry as the source of truth. Raster generation may
  support exploration but must not become the master for geometric UI icons.
- Judge icons as a family and at their intended display sizes. Source-only SVG
  inspection is not visual verification.
- Keep accessibility semantics in the consuming interface. Decorative icons
  should be hidden from assistive technology; meaningful icon-only controls
  need a concise accessible name that describes their function.
- Keep SVGs self-contained. Do not embed scripts, remote resources, raster
  images, or unexplained metadata in production icon files.

## Internal Guidance

- Use `workflows/icon-creation.md` when creating one icon, extending an existing
  family, or producing a new icon set.
- Use `workflows/icon-system-audit.md` when reviewing an icon library,
  implementation, export set, or migration without automatically changing it.
- Use `references/icon-system-specification.md` to define or recover the
  visual and operational contract for an icon family.
- Use `references/lucide-profile.md` when the user requests Lucide-compatible
  icons or when a Lucide-style stroke system has been intentionally selected.
- Use `references/svg-production.md` when authoring, normalizing, exporting, or
  checking SVG source.
- Use `references/icon-review.md` whenever generated or revised icons require
  perceptual, multi-size, accessibility, or family-consistency review.

## Decision Rules

- When an established product system exists, preserve it unless the user asks
  to replace or revise it. Do not silently impose Lucide conventions.
- When no system exists, define a small explicit profile before drawing. A
  single icon can use a lightweight profile; a reusable family needs the full
  specification.
- For a large new family, create a calibration set of three to five icons that
  exercises simple, dense, curved, directional, and modified forms. Review the
  calibration set before scaling production.
- When a concept has no stable or familiar symbol, compare a small set of
  meaningfully different constructions and keep a visible label in the product
  until comprehension is demonstrated.
- When the task only requires choosing an icon from an existing library, keep
  the response narrow. Apply the semantic and consistency checks without
  manufacturing a new system or artifact package.
- When the requested asset is primarily an identity mark, application badge,
  favicon, emoji, or illustration, state that it is outside this skill's
  iconography boundary.

## Deliverables

Match the package to the request. A complete reusable icon delivery normally
includes:

- editable SVG masters
- the icon-system profile or a link to the accepted existing profile
- a semantic inventory with names, use cases, variants, and aliases
- a rendered contact sheet at relevant sizes and themes
- integration notes for color inheritance, accessibility, and component usage
- validation results, known exceptions, and unresolved ambiguities

Do not create documentation or review artifacts the user did not request when
a single verified SVG is sufficient.

## Completion Gate

Do not call icon work complete until the relevant answers are yes:

- Does each icon communicate the intended concept in its actual UI context?
- Does it match the family's geometry, weight, spacing, and modifier rules?
- Has it been rendered and inspected at every required size and theme?
- Is the SVG structurally safe, editable, and compatible with its target?
- Are names, use cases, variants, and accessibility behavior unambiguous?
- Are deviations from the system intentional and recorded?
