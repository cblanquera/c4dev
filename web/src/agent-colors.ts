/** Approved agent-name palette. Light/dark pairs are checked against every label surface. */
export const AGENT_COLORS = [
  { key: 'blue', light: '#1d4ed8', dark: '#93c5fd' },
  { key: 'violet', light: '#6d28d9', dark: '#c4b5fd' },
  { key: 'emerald', light: '#047857', dark: '#6ee7b7' },
  { key: 'amber', light: '#92400e', dark: '#fcd34d' },
  { key: 'rose', light: '#be123c', dark: '#fda4af' },
  { key: 'cyan', light: '#0e7490', dark: '#67e8f9' },
  { key: 'indigo', light: '#4338ca', dark: '#a5b4fc' },
  { key: 'fuchsia', light: '#a21caf', dark: '#f0abfc' },
  { key: 'teal', light: '#0f766e', dark: '#5eead4' },
  { key: 'orange', light: '#9a3412', dark: '#fdba74' },
] as const;

const BASE_NAMES = ['Grace Hopper', 'Linus Torvalds', 'Alex', 'Jamie', 'Sam', 'Riley', 'Casey', 'Jordan', 'Taylor', 'Morgan'];

/** Base profiles have distinct colors; extended names use a stable approved-palette slot. */
export function agentColor(name: string) {
  const base = BASE_NAMES.indexOf(name);
  if (base >= 0) return AGENT_COLORS[base];
  let hash = 0;
  for (const character of name) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}
