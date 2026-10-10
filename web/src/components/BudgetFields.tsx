/**
 * Monthly budget fields for a project or an agent: a spend limit (the
 * providers' estimates) and a token limit (which also covers providers that
 * report no cost), with what's been used this month.
 */
import { formatCost, formatTokens } from '../format.ts';
import { NO_USAGE } from '../store.ts';
import type { UsageTotals } from '../../../server/types.ts';

interface Props {
  id: string;
  usd: number;
  tokens: number;
  onChange: (budget: { usd: number; tokens: number }) => void;
  /** Usage since the 1st of this month. */
  month: UsageTotals | undefined;
  /** What happens when it's reached, e.g. "the coordinator pauses". */
  reached: string;
}

export function BudgetFields({ id, usd, tokens, onChange, month = NO_USAGE, reached }: Props) {
  const used = month.inputTokens + month.outputTokens;
  const over = (usd > 0 && month.costUsd >= usd) || (tokens > 0 && used >= tokens);
  const amount = (value: string) => Math.max(0, Number(value) || 0);
  return (
    <div className="budget-fields">
      <div className="grid2">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-usd`}>Monthly spend limit (USD)</label>
          <input id={`${id}-usd`} type="number" min={0} step={0.5} placeholder="No limit" value={usd || ''} onChange={(e) => onChange({ usd: amount(e.target.value), tokens })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-tokens`}>Monthly token limit</label>
          <input id={`${id}-tokens`} type="number" min={0} step={10000} placeholder="No limit" value={tokens || ''} onChange={(e) => onChange({ usd, tokens: Math.round(amount(e.target.value)) })} />
        </div>
      </div>
      <p className={`small budget-month ${over ? 'is-over' : 'muted'}`} role="status">
        This month: {formatCost(month.costUsd)}{usd ? ` of ${formatCost(usd)}` : ''} · {formatTokens(used)}{tokens ? ` of ${formatTokens(tokens)}` : ''} tokens{over ? `. Budget reached: ${reached}.` : ''}
      </p>
      <p className="field-hint">Counted from the 1st of the month; empty means no limit. When either is reached, {reached}. Tokens are input plus output, so they also cap providers that report no cost.</p>
    </div>
  );
}
