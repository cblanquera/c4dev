# Icon System Audit

Use this workflow for a read-only review of an icon library, product
implementation, export set, or proposed migration. Do not modify icons unless
the user also asks for remediation.

## Establish Scope

Determine which surface is authoritative and which outputs are generated:

- SVG master directory or design-library source
- component package, sprite, icon font, or framework wrappers
- product usages and supported platforms
- design-system documentation and tokens
- deprecated, experimental, and third-party icons

Preserve unrelated files and do not infer that generated output is the source
of truth merely because it is easier to inspect.

## Build the Inventory

Capture, where available:

- canonical name and aliases
- depicted object and documented use cases
- family, variant, state, and direction
- canvas or viewBox, dimensions, stroke and fill behavior
- source file and generated consumers
- accessible labeling pattern
- license or upstream provenance

Identify duplicates, missing variants, ambiguous synonyms, and icons that have
no demonstrated product use. Do not treat a large icon count as evidence of a
healthy system.

## Review Dimensions

### Semantic

- Does the image match its name and documented use cases?
- Are conflicting meanings distinguished by context or labels?
- Do related names and aliases remain predictable?
- Are state and directional variants complete where the product needs them?

### Visual

- Are canvas, live area, keylines, weight, corners, spacing, curves, density,
  and optical balance consistent?
- Are base shapes and modifiers reused consistently?
- Do filled and stroked families have an explicit relationship?
- Are outliers caused by a deliberate semantic need or by drift?

### Technical

- Are masters separated from generated exports?
- Are SVGs self-contained, editable, and free of unsafe or unnecessary data?
- Are colors inherited or tokenized as the system requires?
- Do wrappers preserve viewBox, sizing, stroke scaling, and tree shaking?
- Can every shipped icon be traced to a source and license?

### Accessibility

- Are decorative icons hidden from assistive technology?
- Do icon-only controls receive concise functional names from the control?
- Do visible labels and accessible names agree?
- Are status differences conveyed by more than icon shape or color alone when
  users need another cue?
- Are touch targets sized at the component level rather than by distorting the
  icon artwork?

### Governance

- Is there one accepted icon profile and source of truth?
- Is contribution, review, deprecation, and replacement behavior documented?
- Are naming and metadata requirements enforceable?
- Is rendered QA part of acceptance rather than an optional final glance?

## Finding Format

For each actionable finding, report:

- severity and affected icons or consumers
- observed evidence
- expected system rule or user impact
- recommended correction
- whether the correction belongs in a master, generator, wrapper, token, or UI
  usage

Separate confirmed defects from style preferences and open questions. Group a
shared root cause into one system-level finding instead of repeating it for
every generated icon.

## Audit Deliverable

Return:

- scope and source-of-truth map
- inventory summary
- system profile recovered from actual evidence
- prioritized semantic, visual, technical, accessibility, and governance
  findings
- proposed remediation sequence
- unknowns that require product or design authority

If the user requests fixes after the audit, correct the authoritative layer
first and regenerate dependent outputs through the project's accepted process.
