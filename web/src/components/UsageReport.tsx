/**
 * Usage over time, for every project (Settings → Usage) or one (project
 * settings → Usage): tokens today and over the range, estimated cost, a
 * column chart per day (tokens or cost, one at a time: never two scales on one
 * axis), a table view of the same numbers, and totals per model.
 *
 * Chart rules (dataviz): one series in the accent hue, thin columns with a
 * rounded top on a hairline baseline, values labelled only on the peak and
 * today, and a tooltip on hover and keyboard focus. Text uses text colours.
 */
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { formatCost, formatTokens } from '../format.ts';
import type { UsageReport as Report, UsageTotals } from '../../../server/types.ts';

const RANGES = [7, 30, 90] as const;
type Metric = 'tokens' | 'cost';

const total = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
const full = (n: number) => Math.round(n).toLocaleString('en-US');
/** Costs in tables keep cents (or the first significant digits below a cent). */
const money = (usd: number) => (usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(2)}`);
const dateOf = (day: string) => new Date(`${day}T12:00:00`);
const weekday = (day: string) => dateOf(day).toLocaleDateString(undefined, { weekday: 'short' });
const shortDate = (day: string) => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = (day: string) => dateOf(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/** A round number at or above the peak, for the top gridline. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((n) => n >= value) ?? 10 * step;
}

interface Props {
  /** One project, or every project when absent. */
  projectId?: number;
  /** Changes whenever a run is recorded, so the report refreshes. */
  version: number;
  onError: (message: string) => void;
}

export function UsageReport({ projectId, version, onError }: Props) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [metric, setMetric] = useState<Metric>('tokens');
  const [report, setReport] = useState<Report | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    // Runs arrive in bursts; one refresh per burst is enough.
    const timer = setTimeout(() => {
      api.usageReport(days, projectId).then((r) => live && setReport(r)).catch((err) => live && onError(err instanceof Error ? err.message : 'Failed'));
    }, report ? 400 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [days, projectId, version]);

  if (!report) return <p className="muted small">Loading usage…</p>;
  const today = report.days.at(-1)!;
  const value = (d: UsageTotals) => (metric === 'tokens' ? total(d) : d.costUsd);
  const show = (n: number) => (metric === 'tokens' ? formatTokens(n) : formatCost(n));
  const peak = Math.max(...report.days.map(value));
  const top = niceMax(peak);
  const peakIndex = peak > 0 ? report.days.findIndex((d) => value(d) === peak) : -1;
  const lastIndex = report.days.length - 1;
  // Label every day for a week; otherwise about six evenly spaced dates.
  const every = days === 7 ? 1 : Math.ceil(days / 6);
  const focused = focus === null ? null : report.days[focus];

  return (
    <div className="usage-report">
      <div className="usage-filters">
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((r) => <button key={r} aria-pressed={days === r} onClick={() => { setDays(r); setFocus(null); }}>{r} days</button>)}
        </div>
        <div className="segmented" role="group" aria-label="Chart shows">
          <button aria-pressed={metric === 'tokens'} onClick={() => setMetric('tokens')}>Tokens</button>
          <button aria-pressed={metric === 'cost'} onClick={() => setMetric('cost')}>Cost</button>
        </div>
      </div>

      <div className="usage-tiles">
        <div className="usage-tile">
          <span className="usage-tile-label">Tokens today</span>
          <strong className="usage-tile-value">{formatTokens(total(today))}</strong>
          <span className="muted small">{formatTokens(today.outputTokens)} output · {formatTokens(today.inputTokens)} uncached input</span>
        </div>
        <div className="usage-tile">
          <span className="usage-tile-label">Last {days} days</span>
          <strong className="usage-tile-value">{formatTokens(total(report.total))}</strong>
          <span className="muted small">{formatTokens(report.total.outputTokens)} output · {formatTokens(report.total.cacheReadTokens)} cache reads</span>
        </div>
        <div className="usage-tile">
          <span className="usage-tile-label">Estimated cost, {days} days</span>
          <strong className="usage-tile-value">{formatCost(report.total.costUsd)}</strong>
          <span className="muted small">{full(report.total.runs)} run{report.total.runs === 1 ? '' : 's'} · today {formatCost(today.costUsd)}</span>
        </div>
      </div>

      <section className="usage-chart" aria-labelledby="usage-chart-title">
        <h3 id="usage-chart-title">{metric === 'tokens' ? 'Tokens per day' : 'Estimated cost per day'}</h3>
        <div className="usage-plot" onPointerLeave={() => setFocus(null)}>
          <div className="usage-grid" aria-hidden="true">
            <span style={{ bottom: '100%' }}><em>{show(top)}</em></span>
            <span style={{ bottom: '50%' }}><em>{show(top / 2)}</em></span>
          </div>
          <div className="usage-columns" role="list" aria-label={metric === 'tokens' ? 'Tokens per day' : 'Estimated cost per day'}>
            {report.days.map((d, i) => {
              const v = value(d);
              const labelled = i === peakIndex || i === lastIndex;
              return (
                <div key={d.day} role="listitem" tabIndex={0} className={`usage-column ${focus === i ? 'is-focus' : ''}`}
                  aria-label={`${longDate(d.day)}: ${metric === 'tokens' ? `${full(total(d))} tokens` : money(d.costUsd)}`}
                  onPointerEnter={() => setFocus(i)} onFocus={() => setFocus(i)} onBlur={() => setFocus(null)}>
                  <div className="usage-bar-slot">
                    {labelled && v > 0 && <span className="usage-bar-label" style={{ bottom: `${(v / top) * 100}%` }}>{show(v)}</span>}
                    {v > 0 && <span className="usage-bar" style={{ height: `${Math.max((v / top) * 100, 1)}%` }} />}
                  </div>
                  <span className="usage-x">{i % every === 0 || i === lastIndex ? (days === 7 ? weekday(d.day) : shortDate(d.day)) : ''}</span>
                </div>
              );
            })}
          </div>
          {focused && (
            // Inside the plot, beside the column; edge columns align it inwards so it never leaves the chart.
            <div className={`usage-tooltip ${focus! < report.days.length / 4 ? 'align-start' : focus! >= (report.days.length * 3) / 4 ? 'align-end' : ''}`} role="status"
              style={{ left: `${((focus! + 0.5) / report.days.length) * 100}%` }}>
              <strong>{metric === 'tokens' ? `${full(total(focused))} tokens` : money(focused.costUsd)}</strong>
              <span>{longDate(focused.day)}</span>
              <span className="muted">{full(focused.inputTokens)} input · {full(focused.cacheReadTokens)} cache read · {full(focused.outputTokens)} output</span>
              <span className="muted">{metric === 'tokens' ? `${money(focused.costUsd)} estimated` : `${full(total(focused))} tokens`} · {full(focused.runs)} run{focused.runs === 1 ? '' : 's'}</span>
            </div>
          )}
        </div>
      </section>

      <details className="usage-table-view">
        <summary>Table view</summary>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead><tr><th>Day</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Total</th><th>Est. cost</th></tr></thead>
            <tbody>
              {report.days.map((d) => (
                <tr key={d.day}><td>{d.day}</td><td>{full(d.inputTokens)}</td><td>{full(d.cacheReadTokens)}</td><td>{full(d.cacheWriteTokens)}</td><td>{full(d.outputTokens)}</td><td>{full(total(d))}</td><td>{money(d.costUsd)}</td></tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th>{days} days</th><td>{full(report.total.inputTokens)}</td><td>{full(report.total.cacheReadTokens)}</td><td>{full(report.total.cacheWriteTokens)}</td><td>{full(report.total.outputTokens)}</td><td>{full(total(report.total))}</td><td>{money(report.total.costUsd)}</td></tr>
            </tfoot>
          </table>
        </div>
      </details>

      <section aria-labelledby="usage-models-title">
        <h3 id="usage-models-title">By model</h3>
        {!report.models.length ? <p className="muted small">No runs in the last {days} days.</p> : (
          <div className="usage-table-wrap">
            <table className="usage-table" aria-labelledby="usage-models-title">
              <thead><tr><th>Model</th><th>Runs</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Total</th><th>Est. cost</th></tr></thead>
              <tbody>
                {report.models.map((m) => (
                  <tr key={m.model}><td className="mono">{m.model}</td><td>{full(m.runs)}</td><td>{full(m.inputTokens)}</td><td>{full(m.cacheReadTokens)}</td><td>{full(m.cacheWriteTokens)}</td><td>{full(m.outputTokens)}</td><td>{full(total(m))}</td><td>{money(m.costUsd)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="field-hint">Costs are the providers' own estimates. Simulated runs cost nothing, and Codex reports tokens but no cost. Jev is costed at TypeSafe's published rate.</p>
      </section>
    </div>
  );
}
