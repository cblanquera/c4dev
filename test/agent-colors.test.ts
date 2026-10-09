/** Keep the approved name palette readable whenever the app's label surfaces change. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENT_COLORS, agentColor } from '../web/src/agent-colors.ts';

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255);
  const [r, g, b] = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('approved name colors meet the 4.5:1 target on all light and dark label surfaces', () => {
  const css = fs.readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  const surfaces = [...css.matchAll(/--(?:surface|surface-2|accent-soft):\s*(#[a-f\d]{6})/gi)].map((match) => match[1]);
  assert.equal(surfaces.length, 6);
  for (const color of AGENT_COLORS) {
    for (const background of surfaces.slice(0, 3)) assert.ok(contrast(color.light, background) >= 4.5, `${color.key} light on ${background}`);
    for (const background of surfaces.slice(3)) assert.ok(contrast(color.dark, background) >= 4.5, `${color.key} dark on ${background}`);
  }
});

test('the ten example names have distinct stable palette assignments', () => {
  const names = ['Grace Hopper', 'Linus Torvalds', 'Alex', 'Jamie', 'Sam', 'Riley', 'Casey', 'Jordan', 'Taylor', 'Morgan'];
  assert.equal(new Set(names.map((name) => agentColor(name).key)).size, names.length);
});
