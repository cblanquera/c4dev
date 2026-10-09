/** Markdown → sanitized HTML, with `#12` card references turned into links. */
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';

const cardRef: TokenizerAndRendererExtension = {
  name: 'cardRef',
  level: 'inline',
  start(src) {
    const i = src.search(/(^|[^\w&/(])#\d/);
    return i === -1 ? undefined : i + (src[i] === '#' ? 0 : 1);
  },
  tokenizer(src) {
    const m = /^#(\d+)\b/.exec(src);
    if (m) return { type: 'cardRef', raw: m[0], id: Number(m[1]) };
    return undefined;
  },
  renderer(token) {
    return `<a href="#card-${token.id}" class="card-ref" data-card="${token.id}">#${token.id}</a>`;
  },
};

const marked = new Marked({ gfm: true, breaks: true, extensions: [cardRef] });

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }) as string, { ADD_ATTR: ['data-card', 'target'] });
}
