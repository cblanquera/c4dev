# Lucide-Compatible Profile

Use this profile only when Lucide compatibility has been requested or
intentionally selected. It summarizes Lucide's current public contribution
guidance; verify the upstream documentation before contributing directly to
Lucide because its requirements may evolve.

## Construction Rules

- Use a square `24 × 24` canvas.
- Keep strokes at least 1 coordinate unit from the canvas edge.
- Use 2-unit centered strokes with round caps on open paths and round joins.
- Round most sharp corners. Lucide recommends a 2-unit radius for 90-degree
  corners on elements at least 8 units wide or tall, and a 1-unit radius for
  smaller elements.
- Diagonal lines meeting at 90 degrees commonly need an approximately 2.41-unit
  radius to preserve grid alignment.
- Keep corners sharp where several lines meet if rounding would render poorly.
- Keep at least 2 units of visual separation between distinct elements and,
  where practical, inside shapes.
- Match the visual weight and footprint of Lucide's `circle` and `square`
  anchors.
- Keep icons optically centered, low in unnecessary detail, and smooth in
  curvature.
- Align coordinates and diagonal geometry to the pixel grid when practical,
  but allow intentional optical corrections for recognition and balance.
- Reuse established Lucide base geometry and modifier patterns for related
  icons unless clarity requires a change.

When non-required preferences conflict, prioritize clarity, visual balance,
and consistency with the family.

## Naming

- Use lowercase kebab-case and American English.
- Name the depicted object rather than a possible action or use case.
- Put the family or group first and the visual variant second.
- Describe what makes alternate geometry different; do not append arbitrary
  numbers or `alt`.
- Use numerals only when the number is depicted.
- Order multiple elements by visual size, then front-to-back or reading order
  when sizes are comparable.
- Place modifiers after the element they describe.

## SVG Shape

The standard root uses:

```xml
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <!-- Simple geometry elements -->
</svg>
```

Lucide accepts simple `path`, `line`, `polygon`, `polyline`, `circle`,
`ellipse`, and `rect` geometry. Its contribution format prohibits transforms,
filters, fills, explicit stroke colors, and `use` references. Paths should be
tidy and use appropriate numeric precision.

Those restrictions are Lucide contribution rules. Do not apply them to a
different established system that deliberately uses fills, transforms,
multiple colors, or another SVG contract.

## Metadata and Validation

An upstream Lucide contribution requires a matching JSON metadata file with
contributors, use cases, tags, and allowed categories. Names, metadata, and
SVGs must pass the repository's current icon linting commands.

For product-local icons inspired by Lucide, record provenance and license
requirements and decide explicitly whether to adopt Lucide's metadata contract
or the product's existing one.

## Authoritative Sources

- [Designing icons for Lucide](https://lucide.dev/contribute/icons/)
- [Lucide design language](https://lucide.dev/contribute/icons/design-principles)
- [Icon design specification](https://lucide.dev/contribute/icons/specification)
- [Naming conventions](https://lucide.dev/contribute/icons/naming-conventions)
- [Metadata conventions](https://lucide.dev/contribute/icons/metadata-conventions)
- [SVG conventions](https://lucide.dev/contribute/icons/code-conventions)
- [Lucide contribution guide and Studio](https://lucide.dev/contribute/)
