import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeCoverage, parseCoverage } from '../server/coverage.ts';
import { deriveTitle, parseTags } from '../server/db.ts';

test('parseCoverage reads common reporters', () => {
  assert.equal(parseCoverage('# all files | 92.31 | 85.00 | 100.00 |'), 92.31);
  assert.equal(parseCoverage('ℹ  math.js  | 50.00 | 100.00 | 100.00 |\nℹ all files | 88.10 |   100.00 |  100.00 | '), 88.1);
  assert.equal(parseCoverage('All files |   70.5 |  60 |  80 |  71.2 |'), 71.2);
  assert.equal(parseCoverage('Name  Stmts  Miss  Cover\nTOTAL   120   8   93%'), 93);
  assert.equal(parseCoverage('ok  pkg  0.1s  coverage: 87.5% of statements'), 87.5);
  assert.equal(parseCoverage('nothing here'), null);
});

test('judgeCoverage applies min and target', () => {
  assert.equal(judgeCoverage(95, 80, 90), 'ideal');
  assert.equal(judgeCoverage(85, 80, 90), 'acceptable');
  assert.equal(judgeCoverage(79.9, 80, 90), 'low');
});

test('parseTags finds card references but not anchors or self', () => {
  assert.deepEqual(parseTags('Builds on #3 and #12, see [x](#4) and #3', 12), [3]);
  assert.deepEqual(parseTags('color: &#123; issue#9'), []);
});

test('deriveTitle uses the first meaningful line', () => {
  assert.equal(deriveTitle('![img](/u.png)\n\n## Add **login** page\nmore'), 'Add login page');
  assert.equal(deriveTitle(''), 'Untitled task');
});
