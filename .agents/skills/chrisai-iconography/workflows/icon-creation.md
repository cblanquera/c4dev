# Icon Creation

Use this workflow to create a single UI icon, extend an established family, or
produce a coherent icon set.

## Intake

Identify the smallest set of inputs that changes the design:

- concept and interface use case
- surrounding product or icon family
- target platforms and display sizes
- stroke, fill, duotone, or other construction style
- required states, directions, modifiers, and variants
- source and delivery formats
- accessibility and localization constraints

If non-blocking information is missing, inspect the local product and choose a
conservative default. State assumptions rather than stopping for preferences
that can be changed during review.

## Workflow

### 1. Inspect the Existing System

Find the current icon source of truth before drawing:

- icon directories, SVG sprites, component wrappers, Figma exports, packages,
  tokens, and design-system documentation
- repeated canvas sizes, live areas, stroke widths, caps, joins, radii, optical
  offsets, and modifier placements
- naming patterns, aliases, categories, and accessibility conventions
- licenses and attribution obligations for inherited or adapted geometry

Distinguish authored masters from generated components and exports. Edit the
authoritative source when the task permits changes.

### 2. Decide Whether Creation Is Necessary

Search the accepted family for an icon with the same depicted object or a
clear semantic equivalent. Reuse it when the fit is strong.

Create a new icon when the existing library lacks the concept, the available
symbol is materially ambiguous in context, or the user explicitly wants an
original family. Record why a near match was rejected when that decision will
matter to reviewers.

### 3. Define the Semantic Brief

For every proposed icon, record:

- depicted object or visual construction
- primary interface use case
- secondary use cases that do not contradict the primary meaning
- concepts the icon must not be mistaken for
- whether a visible label is still required
- family relationships, states, and modifiers

Name the icon for what it depicts. Keep action or product meanings in the use
cases unless the established system deliberately uses semantic names.

### 4. Lock the Construction Profile

Use the existing profile or define one with
`references/icon-system-specification.md`. Use
`references/lucide-profile.md` only when Lucide compatibility has been chosen.

For a family, create a calibration set before the full inventory. Include a
simple icon, a dense icon, a curved icon, a directional icon, and a modified or
compound icon when those forms occur in the requested set.

### 5. Construct the SVG Masters

- Start with the silhouette and largest structural shapes.
- Reuse accepted base geometry and modifiers exactly where appropriate.
- Prefer the fewest control points that preserve the intended form.
- Use geometric alignment as a starting point and optical correction as a
  deliberate finishing move.
- Preserve negative space at the smallest intended size.
- Avoid decorative detail that does not improve recognition.
- Keep directional variants and state families structurally related.

Follow `references/svg-production.md` for file structure and normalization.

### 6. Render and Review

Use `references/icon-review.md` to generate and inspect a contact sheet. Review
the icons:

- at every intended display size, not only enlarged
- beside stable family anchors and related icons
- in relevant light, dark, active, disabled, and selected contexts
- both in isolation and inside representative buttons, menus, fields, or
  navigation items

If the profile is still being established, obtain review on the calibration
set before multiplying unresolved geometry across the full set.

### 7. Normalize and Package

After visual approval:

- normalize SVG structure without changing approved appearance
- remove editor residue, unsafe content, and accidental hard-coded colors
- apply accepted names and metadata
- generate framework components or sprites from the masters when required
- preserve masters separately from generated targets
- include the final contact sheet and record intentional exceptions

## Revision Discipline

- Treat accepted geometry as the baseline for later variants.
- Apply feedback to the latest accepted source, not a degraded preview or
  rasterized derivative.
- When one change affects the whole family, update the calibration icons first
  and show the system-level consequence before applying it everywhere.
- Do not reinterpret unrelated icons during a narrowly scoped revision.

## Ready Check

- The need for a new icon was established.
- The semantic brief and system profile agree.
- The SVG master is editable and structurally safe.
- Intended sizes and contexts were rendered and inspected.
- Related icons share geometry and optical weight.
- Accessibility behavior belongs to the consuming UI and is documented.
- Generated exports can be traced back to the master.
