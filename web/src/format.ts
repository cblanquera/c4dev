/** Compact numbers for token and cost readouts. */
import type { UsageTotals } from '../../server/types.ts';

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Costs are SDK estimates; tiny amounts don't round to a misleading $0.00. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** e.g. "12.3k tokens · $0.42 · 7 runs"; cache tokens are part of the cost, not the count. */
export function usageLine(u: UsageTotals): string {
  return `${formatTokens(u.inputTokens + u.outputTokens)} tokens · ${formatCost(u.costUsd)} · ${u.runs} run${u.runs === 1 ? '' : 's'}`;
}
