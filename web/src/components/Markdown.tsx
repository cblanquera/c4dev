import { useMemo } from 'react';
import { renderMarkdown } from '../markdown.ts';

/** Renders markdown; clicks on #id references open that card. */
export function Markdown({ source, onCardClick, className = '' }: { source: string; onCardClick?: (id: number) => void; className?: string }) {
  const html = useMemo(() => renderMarkdown(source || ''), [source]);
  return (
    <div
      className={`markdown ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a[data-card]');
        if (a && onCardClick) {
          e.preventDefault();
          onCardClick(Number(a.getAttribute('data-card')));
        }
      }}
    />
  );
}
