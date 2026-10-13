/**
 * Create / edit a card. The description is the human's words; the agent
 * instructions are the coordinator's reading of them. Regenerate until the
 * reading is right, then save — saved cards land in the Icebox.
 */
import { Icon } from './Icon.tsx';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import { Markdown } from './Markdown.tsx';
import type { Card } from '../../../server/types.ts';

interface Props {
  card: Card | null;
  projectId: number;
  parentId: number | null;
  cards: Card[];
  onSaved: (card: Card) => void;
  onDeleted: () => void;
  onCardClick: (id: number) => void;
  onError: (message: string) => void;
}

export function CardEditor({ card, projectId, parentId, cards, onSaved, onDeleted, onCardClick, onError }: Props) {
  const [description, setDescription] = useState(card?.description ?? (parentId ? `Follow-up to #${parentId}\n\n` : ''));
  const [instructions, setInstructions] = useState(card?.instructions ?? '');
  const [hash, setHash] = useState<string | null>(card?.instructionsHash ?? null);
  /** The description the current instructions were generated from. */
  const [generatedFor, setGeneratedFor] = useState<string | null>(card?.instructionsCurrent ? card.description : null);
  const [generating, setGenerating] = useState(false);
  /** Jev's note that the description is too vague to write instructions from. */
  const [vague, setVague] = useState('');
  const [activity, setActivity] = useState<string[]>([]);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const hasInstructions = !!instructions.trim();
  const stale = hasInstructions && generatedFor !== description;
  const dirty = !card || description !== card.description || instructions !== card.instructions || hash !== card.instructionsHash;
  const backlogBlocker = !card
    ? 'Saved cards stay in the Icebox. Add instructions whenever you’re ready.'
    : dirty ? 'Unsaved changes'
    : !hasInstructions ? 'Generate instructions before the Backlog'
    : stale ? 'Instructions are outdated'
    : '';

  async function generate(force = false) {
    if (!description.trim()) return onError('Describe the task first.');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const source = description;
    setGenerating(true);
    setActivity([]);
    setVague('');
    setEditingInstructions(false);
    let streamed = '';
    try {
      const result = await api.generateInstructions(source, projectId, card?.id ?? null, {
        status: (text) => setActivity((a) => [...a.slice(-5), text]),
        text: (chunk) => {
          streamed += chunk;
          setInstructions(streamed);
        },
      }, controller.signal, force);
      if ('vague' in result) {
        setVague(result.vague);
        return;
      }
      setInstructions(result.instructions);
      setHash(result.hash);
      setGeneratedFor(source);
    } catch (err) {
      if (!controller.signal.aborted) onError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      if (abortRef.current === controller) {
        setGenerating(false);
        abortRef.current = null;
      }
    }
  }

  /** Saving always keeps the card in the Icebox; instructions can come later. */
  async function save() {
    if (!description.trim()) return onError('Write at least a title first.');
    setSaving(true);
    try {
      const body = { description, instructions, instructionsHash: hash };
      onSaved(card ? await api.update(card.id, body) : await api.create({ ...body, projectId, parentId }));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  /** Same as dragging to the Backlog, for a saved card (and for touch screens, which can't drag). */
  async function moveToBacklog() {
    if (!card) return;
    setSaving(true);
    try {
      await api.move(card.id, 'backlog', null, null);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="editor">
      <section className="editor-section">
        <div className="section-head">
          <h3>Task</h3>
          <span className="muted small">What you want, in your words.</span>
        </div>
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          cards={cards}
          selfId={card?.id ?? null}
          autoFocus={!card}
          placeholder={'# Short title\n\nDescribe the outcome you want, who it is for, and how you will know it works.\n\n- Bullet points become measurable pieces of work\n- Reference related cards with #'}
          onCardClick={onCardClick}
        />
      </section>

      <section className={`editor-section instructions ${stale ? 'is-stale' : ''}`}>
        <div className="section-head">
          <h3>Agent instructions</h3>
          <span className="spacer" />
          {hasInstructions && !generating && (
            <button className="ghost small" onClick={() => setEditingInstructions((v) => !v)}>{editingInstructions ? 'Done editing' : 'Edit'}</button>
          )}
          <button className={hasInstructions && !stale ? 'secondary' : 'primary'} onClick={generating ? () => abortRef.current?.abort() : () => generate()} disabled={!description.trim() && !generating}>
            <Icon name={generating ? 'square' : hasInstructions ? 'rotate-ccw' : 'sparkles'} />
            {generating ? 'Stop' : hasInstructions ? 'Regenerate' : 'Generate instructions'}
          </button>
        </div>

        {stale && !generating && (
          <div className="notice warn">
            The task changed since these instructions were generated.
            <span className="spacer" />
            <button className="link small" onClick={() => generate()}>Regenerate</button>
            <button className="link small" onClick={() => { setGeneratedFor(description); setHash('current'); }}>Keep as is</button>
          </div>
        )}

        {vague && !generating && (
          <div className="notice warn" role="status">
            {vague}
            <span className="spacer" />
            <button className="link small" onClick={() => generate(true)}>Generate anyway</button>
          </div>
        )}

        {generating && (
          <div className="gen-activity" aria-live="polite">
            <Icon name="loader-circle" size={12} className="spinner" /> {activity.at(-1) ?? 'Reading the repository…'}
          </div>
        )}

        {!hasInstructions && !generating ? (
          <div className="instructions-empty">
            <p>Generate instructions to see how the agents will read your task.</p>
            <p className="muted small">If they get it wrong, improve the task description and regenerate until you agree. Pay attention to <em>Assumptions</em> and <em>Open questions</em>.</p>
          </div>
        ) : editingInstructions ? (
          <textarea className="instructions-edit" value={instructions} rows={18} onChange={(e) => setInstructions(e.target.value)} />
        ) : (
          <Markdown source={instructions} onCardClick={onCardClick} className="md-box instructions-doc" />
        )}
      </section>

      <footer className="editor-actions">
        {card && <button className="danger ghost" onClick={async () => {
          if (!confirm(`Delete card #${card.id}?`)) return;
          await api.remove(card.id).then(onDeleted, (e) => onError(e.message));
        }}>Delete</button>}
        <span className="spacer" />
        <span className="muted small">{backlogBlocker}</span>
        {card && (
          <button className="secondary" disabled={saving || generating || !!backlogBlocker} onClick={moveToBacklog} title="Queue this card for the coordinator">Move to Backlog <Icon name="arrow-right" /></button>
        )}
        <button className="primary" disabled={saving || generating || !description.trim() || (!!card && !dirty)} onClick={save}>{card ? 'Save' : 'Create in Icebox'}</button>
      </footer>
    </div>
  );
}
