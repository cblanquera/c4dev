# Icon Review

Use this reference for every generated or revised icon whose acceptance depends
on appearance. Review rendered output, not only SVG markup or vector-editor
coordinates.

## Review Artifact

Create a contact sheet or equivalent inspectable artifact that shows:

- every icon at the actual required sizes
- enlarged geometry for diagnosis, clearly separated from native-size proof
- stable family anchors and the closest related icons
- icon name and intended use case outside the artwork
- light and dark contexts when both are supported
- active, disabled, selected, warning, and destructive contexts when relevant
- representative controls such as buttons, menus, fields, tabs, and navigation
  items

Keep review notes outside production artwork. The icon itself must not contain
measurement labels, annotations, or review decoration.

## Perceptual Checks

### Recognition

- Is the depicted object identifiable at native size?
- Does the icon avoid looking like another icon in the same family?
- Does the symbol remain understandable in its real interface context?
- Is a visible label needed because the concept is unfamiliar or ambiguous?

### Weight and Footprint

- Does it look equally prominent beside the family anchors?
- Do dense regions become darker than neighboring icons?
- Do large empty shapes appear too light despite matching stroke width?
- Does a slight blur or squint test reveal weight imbalance?

### Balance and Geometry

- Does the icon look centered rather than merely measure as centered?
- Are curves smooth and terminals intentional?
- Are negative spaces still open at the smallest size?
- Are optical offsets justified by appearance?
- Do directional variants and repeated modifiers share geometry?

### Family Consistency

- Are grid, live area, corners, caps, joins, spacing, density, and detail level
  consistent?
- Do related icons preserve the same base construction?
- Are modifiers placed and sized consistently?
- Does the icon feel like a member of the family without sacrificing clarity?

## Context and Accessibility Checks

- Pair ambiguous actions with visible text until comprehension is established.
- Check that icon-only controls have concise functional accessible names.
- Hide decorative SVGs when their parent already carries the accessible name.
- Verify that color is not the only cue for a state that users must distinguish.
- Test mirrored or directional meaning in right-to-left contexts when relevant.
- Review culturally specific metaphors with the target audience or product
  authority rather than assuming universality.

## Review Sequence

1. Review the calibration set if the family profile is new or changing.
2. Fix system-level issues before producing the full inventory.
3. Review the complete family for outliers and duplicate meanings.
4. Review target UI contexts for scale, labeling, color, and control alignment.
5. Normalize source and run technical checks only after appearance is accepted.
6. Re-render after normalization to prove that the output did not change.

## Finding Language

Tie feedback to observable evidence:

- `search` reads heavier than the `circle` anchor at 16px because its handle
  overlaps the ring too closely.
- the `add` modifier shifts between top-right and bottom-right across the family
  without a semantic reason.
- `archive` and `inbox` become indistinguishable at 12px because their interior
  gaps close.

Avoid unsupported statements such as `this does not feel polished`. Name the
visible issue, affected context, and system rule.

## Approval Gate

An icon or family is ready only when:

- native-size rendering is legible and balanced
- family anchors and related icons show consistent weight
- the intended meaning and unacceptable confusions were reviewed
- supported themes and contexts preserve the design
- accessibility behavior is defined at the consuming component
- no normalization or export step changed the accepted appearance
