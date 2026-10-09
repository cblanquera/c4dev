# Icon System Specification

Use this reference to define a new icon family or recover the contract of an
existing one. Record decisions supported by real source material; label
inferred rules as inferred until they are accepted.

## System Identity

Record:

- system name and intended products
- source-of-truth location
- owners and approval authority
- supported platforms and rendering environments
- relationship to any upstream icon library
- licensing and attribution requirements

## Semantic Model

Define:

- whether canonical names describe appearance, interface meaning, or a stated
  hybrid
- naming case and word-order rules
- categories, tags, use cases, aliases, and deprecation metadata
- variant grammar for direction, state, severity, placement, and style
- rules for selecting an existing icon versus adding a new one
- concepts that require visible labels because the symbol is ambiguous,
  unfamiliar, culturally variable, or safety-critical

Keep depicted object and use case as separate fields unless the accepted system
explicitly combines them.

## Visual Profile

Specify values or decision rules for:

| Area | Required decision |
| --- | --- |
| Canvas | Coordinate system and aspect-ratio policy |
| Live area | Default padding and allowed overshoot |
| Keylines | Shared circles, squares, rectangles, diagonals, and centers |
| Style | Stroke, fill, duotone, multicolor, or supported combinations |
| Weight | Stroke widths or filled-area targets at each optical size |
| Terminals | Cap style and exceptions |
| Joins | Join style, miter limit, and exceptions |
| Corners | Radius scale and acute-corner treatment |
| Spacing | Minimum internal and external gaps at target sizes |
| Curves | Preferred curve types and control-point discipline |
| Alignment | Grid alignment and allowed optical offsets |
| Density | Maximum useful detail and simplification behavior |
| Modifiers | Size, placement, clearance, and relationship to base geometry |
| Direction | Mirroring and culturally dependent direction rules |
| Color | Inheritance, tokens, layers, and theme behavior |

Do not force all optical sizes to be simple mathematical scaling when the
product needs size-specific masters. Small icons may require fewer details,
wider gaps, or adjusted weight.

## Family Geometry

Choose a small set of stable anchors that represent the system's expected
weight and footprint, such as circle, square, document, person, arrow, and
status modifier. Use these anchors during review.

Document reusable geometry for:

- containers and badges
- arrows and chevrons
- plus, minus, check, close, alert, and status marks
- selection, notification, lock, add, remove, and directional modifiers
- recurring objects and their accepted orientation

Variants should inherit approved base geometry unless clarity at the target
size requires a recorded exception.

## Output Contract

Define:

- master format and directory
- filename and metadata-file conventions
- allowed SVG elements and attributes
- precision, optimization, and editor-residue policy
- color and sizing behavior in consuming components
- generated targets such as framework components, sprites, or fonts
- required tests, linters, contact sheets, and human review
- versioning, deprecation, replacement, and migration behavior

Generated outputs must identify or preserve a reproducible path back to the
master source.

## Calibration Set

Before producing a large family, select three to five representative icons:

- a simple geometric form
- a recognizable curved object
- a dense or compound concept
- a directional form
- a base icon with a modifier

The calibration set should expose weaknesses in spacing, weight, corners,
curves, and modifier placement before those decisions spread.

## Acceptance Record

Record:

- accepted profile version
- accepted calibration icons
- intentional exceptions and rationale
- unresolved semantic or platform questions
- the review artifact and sizes used for approval
- any upstream profile version or source checked
