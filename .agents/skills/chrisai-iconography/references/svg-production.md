# SVG Production

Use this reference when authoring, cleaning, exporting, or checking SVG icon
masters. The accepted icon-system profile remains authoritative for visual
choices.

## Source Principles

- Keep one editable master for each canonical icon.
- Use a stable viewBox and let consuming components control rendered size.
- Prefer `currentColor` for single-color UI icon systems unless the accepted
  profile specifies tokens or layered colors.
- Use simple vector geometry and the minimum useful number of control points.
- Preserve reusable base geometry across related icons.
- Avoid converting clean primitives to opaque path data unless the build or
  delivery target requires it.
- Avoid expanding strokes in a stroke-based system unless the master-format
  contract explicitly requires outlined shapes.

## Safe Structure

Production icon SVGs should be self-contained and reviewable. Remove or reject:

- scripts, event-handler attributes, and executable content
- remote URLs, external stylesheets, external fonts, and linked resources
- embedded raster images unless the accepted format explicitly needs them
- editor namespaces, guides, hidden layers, comments, and private metadata that
  do not belong in the delivery
- unexplained IDs, masks, clip paths, filters, or transforms
- hard-coded presentation values that conflict with color or theme inheritance

Complex elements are not universally wrong. Keep them only when the accepted
profile needs them and the target renderers support them.

## Normalization

Normalize only after the visible design is accepted:

- stable root namespace and viewBox
- predictable attribute ordering when the repository enforces it
- approved numeric precision
- no accidental width and height behavior
- no geometry outside the allowed canvas unless intentional overshoot is
  documented
- no invisible, empty, duplicate, or zero-length elements
- deterministic formatting compatible with the project's generator or linter

Optimization must not change approved geometry or collapse elements needed for
animation, theming, or component-level control.

## Responsive Rendering

Check how the consuming system handles:

- `width` and `height`
- stroke scaling and non-scaling strokes
- CSS color inheritance
- currentColor and theme tokens
- right-to-left mirroring
- high-contrast or forced-color modes
- sprite IDs and collisions
- server rendering and hydration

Do not solve component touch-target sizing by enlarging the icon's viewBox or
artwork. The host control owns its interactive target.

## Accessibility Integration

For decorative icons inside a labeled control, hide the SVG from assistive
technology and keep it unfocusable where the target platform requires that.

For icon-only controls, give the button or link a concise functional accessible
name such as `Close`, not a description of the geometry such as `X icon`.

For a standalone informative SVG, expose it as an image and provide a nonempty
accessible name through the target platform's supported mechanism. Do not put
the same information in both the SVG and its labeled parent if that causes
duplicate announcements.

Accessibility references:

- [W3C Design System SVG icons](https://design-system.w3.org/styles/svg-icons.html)
- [WAI accessible names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)
- [W3C SVG accessible-name rule](https://www.w3.org/WAI/standards-guidelines/act/rules/7d6734/)

## Technical Review

Use available project-native formatters and validators first. At minimum,
confirm:

- the SVG parses without errors
- the viewBox and geometry follow the accepted profile
- prohibited or unsafe content is absent
- inherited colors work in supported themes
- all target renderers display the same approved geometry
- generated components or sprites can be reproduced from the master

Technical validity is necessary but not sufficient. Complete the rendered
review in `icon-review.md`.
