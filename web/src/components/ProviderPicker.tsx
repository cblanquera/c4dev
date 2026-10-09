/**
 * Provider and model choice, shared by every form that picks a model. Only
 * providers switched on in Settings → Providers are offered.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon.tsx';
import type { DriverName, ProviderStatus } from '../../../server/types.ts';

interface SelectProps {
  id: string;
  providers: ProviderStatus[];
  value: DriverName;
  onChange: (value: DriverName) => void;
  describedBy?: string;
}

export function ProviderSelect({ id, providers, value, onChange, describedBy }: SelectProps) {
  const offered = providers.filter((p) => p.enabled || p.id === value);
  return (
    <select id={id} aria-describedby={describedBy} value={value} onChange={(e) => onChange(e.target.value as DriverName)}>
      <option value="simulated">Simulated (demo)</option>
      {offered.map((p) => (
        <option key={p.id} value={p.id} disabled={!p.runsWork}>
          {p.label}{p.runsWork ? '' : ' (not yet supported)'}{p.available ? '' : ' (not installed)'}
        </option>
      ))}
    </select>
  );
}

interface ModelProps {
  id: string;
  providers: ProviderStatus[];
  /** The provider the model is for; simulated means no model is used. */
  provider: DriverName;
  value: string;
  onChange: (value: string) => void;
  /** Shown when empty, e.g. "Provider's default model". */
  placeholder?: string;
  describedBy?: string;
}

const MAX_SHOWN = 80;

/**
 * A model id with the provider's known models in a dropdown right under the
 * field: it filters as you type, works with arrow keys and Enter, and any id
 * can still be typed.
 */
export function ModelInput({ id, providers, provider, value, onChange, placeholder, describedBy }: ModelProps) {
  const models = providers.find((p) => p.id === provider)?.models ?? [];
  const simulated = provider === 'simulated';
  const [open, setOpen] = useState(false);
  /** What was typed since opening; null shows every model. */
  const [filter, setFilter] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const query = filter?.trim().toLowerCase() ?? '';
  const matches = (query ? models.filter((m) => m.toLowerCase().includes(query)) : models).slice(0, MAX_SHOWN);
  const showing = open && !simulated && matches.length > 0;
  const listId = `${id}-list`;

  // Fixed to the field, so a scrolling dialog can't clip it.
  useLayoutEffect(() => {
    if (!showing) return;
    const place = () => {
      const r = field.current!.getBoundingClientRect();
      setBox({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [showing]);

  function show() {
    setFilter(null);
    setActive(-1);
    setOpen(true);
  }

  function choose(model: string) {
    onChange(model);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (matches.length ? (a + step + matches.length) % matches.length : -1));
    } else if (e.key === 'Enter' && showing && active >= 0) {
      e.preventDefault();
      choose(matches[active]);
    } else if (e.key === 'Escape' && showing) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="combo" ref={field}>
      <input id={id} className="mono" role="combobox" aria-expanded={showing} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showing && active >= 0 ? `${id}-option-${active}` : undefined} aria-describedby={describedBy} autoComplete="off"
        value={simulated ? '' : value} disabled={simulated}
        placeholder={simulated ? 'The simulation uses no model' : placeholder ?? (models.length ? 'Pick or type a model' : 'Type a model id')}
        onFocus={show} onBlur={() => setOpen(false)} onKeyDown={onKeyDown}
        onChange={(e) => { onChange(e.target.value); setFilter(e.target.value); setActive(-1); setOpen(true); }} />
      {!simulated && models.length > 0 && (
        <button type="button" className="combo-toggle ghost" tabIndex={-1} aria-label="Show models"
          onMouseDown={(e) => e.preventDefault()} onClick={() => (showing ? setOpen(false) : (show(), field.current?.querySelector('input')?.focus()))}>
          <Icon name="chevron-down" size={14} />
        </button>
      )}
      {showing && box && (
        <ul id={listId} role="listbox" aria-label="Models" className="combo-list" style={{ top: box.top, left: box.left, width: box.width }}>
          {matches.map((m, i) => (
            <li key={m} id={`${id}-option-${i}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); choose(m); }}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
