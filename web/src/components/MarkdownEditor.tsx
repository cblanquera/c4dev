/**
 * GitHub-style markdown editor: Write / Preview tabs, `#` to reference other
 * cards (with autocomplete), and image attachments by paste, drop or picker.
 */
import { Icon } from './Icon.tsx';
import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';
import type { Card } from '../../../server/types.ts';

interface Props {
  value: string;
  onChange: (value: string) => void;
  cards: Card[];
  selfId: number | null;
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  minRows?: number;
  ariaLabel?: string;
  onSubmit?: () => void;
  onCardClick?: (id: number) => void;
}

export function MarkdownEditor({ value, onChange, cards, selfId, placeholder, readOnly, autoFocus, minRows = 12, ariaLabel, onSubmit, onCardClick }: Props) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Uploads finish asynchronously; always edit the latest text.
  const valueRef = useRef(value);
  valueRef.current = value;

  const suggestions = useMemo(() => {
    if (query == null) return [];
    const q = query.toLowerCase();
    return cards
      .filter((c) => c.id !== selfId && !c.hidden && (String(c.id).startsWith(q) || c.title.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6);
  }, [query, cards, selfId]);

  function detectTag() {
    const el = ref.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(/(?:^|\s)#([\w-]*)$/);
    setQuery(m ? m[1] : null);
    setHighlight(0);
  }

  function insertTag(card: Card) {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/#[\w-]*$/, `#${card.id} `);
    const next = before + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (!suggestions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertTag(suggestions[highlight]);
    } else if (e.key === 'Escape') {
      setQuery(null);
    }
  }

  async function attach(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    setUploadError('');
    const el = ref.current;
    const caret = el?.selectionStart ?? valueRef.current.length;
    const placeholders = images.map((f, i) => `![Uploading ${f.name || 'image'}…${i}]()`);
    const block = `${placeholders.join('\n')}\n`;
    const current = valueRef.current;
    const prefix = caret > 0 && current[caret - 1] !== '\n' ? '\n' : '';
    onChange(current.slice(0, caret) + prefix + block + current.slice(caret));
    for (const [i, file] of images.entries()) {
      try {
        const url = await api.upload(file);
        const alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
        onChange(valueRef.current.replace(placeholders[i], `![${alt}](${url})`));
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload failed');
        onChange(valueRef.current.replace(`${placeholders[i]}\n`, ''));
      }
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      attach(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    attach([...e.dataTransfer.files]);
  };

  if (readOnly) return <Markdown source={value} onCardClick={onCardClick} className="md-box" />;

  return (
    <div className={`md-editor ${dragging ? 'dragging' : ''}`}>
      <div className="md-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'write'} className={tab === 'write' ? 'active' : ''} onClick={() => setTab('write')}>Write</button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Preview</button>
        <span className="md-tools">
          <button type="button" className="ghost small" title="Reference another card" onClick={() => {
            const caret = ref.current?.selectionStart ?? value.length;
            const pre = value.slice(0, caret);
            const insert = pre && !/\s$/.test(pre) ? ' #' : '#';
            onChange(pre + insert + value.slice(caret));
            setTab('write');
            requestAnimationFrame(() => {
              const el = ref.current;
              if (!el) return;
              el.focus();
              el.setSelectionRange(caret + insert.length, caret + insert.length);
              setQuery('');
            });
          }}><Icon name="hash" size={14} /> Tag</button>
          <button type="button" className="ghost small" title="Attach images" onClick={() => fileRef.current?.click()}><Icon name="image-plus" size={14} /> Image</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => {
            attach([...(e.target.files ?? [])]);
            e.target.value = '';
          }} />
        </span>
      </div>
      {tab === 'write' ? (
        <div className="md-write" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <textarea
            ref={ref}
            aria-label={ariaLabel}
            value={value}
            rows={minRows}
            autoFocus={autoFocus}
            placeholder={placeholder}
            onChange={(e) => {
              onChange(e.target.value);
              requestAnimationFrame(detectTag);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) detectTag(); }}
            onClick={detectTag}
            onBlur={() => setTimeout(() => setQuery(null), 150)}
            onPaste={onPaste}
          />
          {suggestions.length > 0 && (
            <ul className="tag-menu" role="listbox">
              {suggestions.map((c, i) => (
                <li key={c.id} role="option" aria-selected={i === highlight} className={i === highlight ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); insertTag(c); }}>
                  <span className="mono">#{c.id}</span> {c.title} <span className={`stage-dot s-${c.stage}`} />
                </li>
              ))}
            </ul>
          )}
          <div className="md-hint">Markdown supported · type <kbd>#</kbd> to reference a card · paste or drop images</div>
        </div>
      ) : (
        <Markdown source={value || '_Nothing to preview._'} onCardClick={onCardClick} className="md-box" />
      )}
      {uploadError && <div className="error-text">{uploadError}</div>}
    </div>
  );
}
