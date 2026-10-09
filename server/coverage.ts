/**
 * Extracts a total line-coverage percentage from whatever the project's
 * coverage tool produced. Tries machine-readable summaries first, then the
 * text reports of common tools.
 */
import fs from 'node:fs';
import path from 'node:path';

const SUMMARY_FILES = ['coverage/coverage-summary.json', 'coverage/coverage-final-summary.json'];

/** Istanbul/nyc/c8/vitest/jest `json-summary` reporter output. */
function fromSummaryFile(cwd: string): number | null {
  for (const rel of SUMMARY_FILES) {
    const file = path.join(cwd, rel);
    if (!fs.existsSync(file)) continue;
    try {
      const pct = JSON.parse(fs.readFileSync(file, 'utf8'))?.total?.lines?.pct;
      if (typeof pct === 'number') return pct;
    } catch {
      // fall through to text parsing
    }
  }
  return null;
}

const TEXT_PATTERNS: RegExp[] = [
  // istanbul text table: "All files |   92.3 |  85 |  100 |  92.3 |" (statements first)
  /All files\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*([\d.]+)/,
  // node --test --experimental-test-coverage: "ℹ all files | 92.31 | 85.00 | 100.00 |" (older: "# all files")
  /^[#ℹ]?\s*all files\s*\|\s*([\d.]+)/im,
  // python coverage: "TOTAL   120   8   93%"
  /^TOTAL\s+.*?(\d+(?:\.\d+)?)%\s*$/m,
  // go: "coverage: 87.5% of statements"
  /coverage:\s*([\d.]+)% of statements/,
  // JaCoCo/others: "Line coverage: 91.2%" / "Lines: 91.2%"
  /lines?(?:\s+coverage)?\s*[:=]\s*([\d.]+)%/i,
];

export function parseCoverage(output: string, cwd?: string): number | null {
  if (cwd) {
    const fromFile = fromSummaryFile(cwd);
    if (fromFile != null) return fromFile;
  }
  for (const re of TEXT_PATTERNS) {
    const all = [...output.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
    const last = all.at(-1);
    if (last) return Number(last[1]);
  }
  return null;
}

export type CoverageVerdict = 'ideal' | 'acceptable' | 'low';

export function judgeCoverage(pct: number, min: number, target: number): CoverageVerdict {
  if (pct >= target) return 'ideal';
  if (pct >= min) return 'acceptable';
  return 'low';
}
