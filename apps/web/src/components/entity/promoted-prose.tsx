'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { Field } from '@/components/table-view/use-table-data';
import { cn } from '@/lib/utils';
import { CollapsibleBody, useCollapsedSection } from './collapsible-section';
import { FieldMenu } from './field-controls';
import type { Zone } from './entity-field-utils';
import { BLOCK_SURFACE, LongTextHeader, LongTextMenu, MarkdownBody } from './long-text-block';

// Eight lines of `text-reading` — 13px at 1.625 leading = 21.125px a line, so
// 169px, plus ~3px of slack so the eighth line is never shaved. Deliberately
// NOT tied to the 180-char promotion threshold in record-detail.tsx: that
// number decides WHERE a field renders, this one decides how much of it shows
// before "Show all". The button is gated on measured overflow, so the two
// cannot disagree.
//
// #792 — THIS CONSTANT IS DERIVED FROM THE READING LEADING, so --text-reading's
// line-height in globals.css is load-bearing beyond styling. Change it and this
// clamp silently shows the wrong number of lines: nothing fails to compile and
// no test catches it, because the only symptom is a clamp that lands mid-line.
// If the reading leading ever moves, re-derive this number in the same commit.
const CLAMP_PX = 172;

/**
 * #780 Rule 1 / #802 — a long text field promoted out of the grid into a titled
 * prose block. It must stay editable and must only offer "Show all" when the content really is clipped.
 *
 * #954 — it is now the same block as a rich_text field and the description: the shared
 * header (caret, label, a persistent ⋯ with Copy / Download / field settings), no box at rest, a card
 * surface on hover, focus and edit. A `text` field renders its Markdown at rest and edits its STORED
 * SOURCE in place, at the block's own width (rich text edits what you see; plain text edits what is
 * stored, so a synced field is never parsed and re-serialised). The popover is gone; it was right for
 * a 32px grid row and wrong for a block.
 */
export function PromotedProse({
  ws,
  db,
  field,
  text,
  readOnly,
  schemaEditable,
  onToggleZone,
  onCommit,
}: {
  ws: string;
  db: string;
  field: Field;
  text: string;
  readOnly: boolean;
  schemaEditable: boolean;
  onToggleZone: (field: Field, zone: Zone) => void;
  onCommit: (field: Field, value: unknown) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [overflows, setOverflows] = useState(false);
  const { collapsed, toggle } = useCollapsedSection(db, field.id);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  // Escape cancels; the blur that follows the textarea unmounting must not save it.
  const cancelled = useRef(false);

  // scrollHeight is the full content height even while overflow-hidden clips
  // it, so one measure answers "would this be clipped?" in both states.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > CLAMP_PX + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, editing]);

  // Auto-grow from the content so nothing jumps when the block turns into a textarea.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  const startEdit = () => {
    if (readOnly) return;
    cancelled.current = false;
    // The draft is seeded ONCE, here. A sync that rewrites `text` while this is open does not
    // clobber what is being typed; saving then writes the draft, as the old popover did.
    setDraft(text);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    setEditing(false);
    if (save && draft !== text) onCommit(field, draft);
  };

  const markdown = { get: () => text, filename: field.displayName };

  return (
    <div className="max-w-[74ch]">
      <LongTextHeader
        label={field.displayName}
        collapsed={collapsed}
        onToggle={toggle}
        menu={
          schemaEditable ? (
            <FieldMenu ws={ws} db={db} field={field} onToggleZone={onToggleZone} collection persistent markdown={markdown} />
          ) : (
            <LongTextMenu label={field.displayName} markdown={markdown} />
          )
        }
      />
      <CollapsibleBody collapsed={collapsed}>
        {editing ? (
          <div className={cn(BLOCK_SURFACE, '-mx-3 border-border-default bg-card px-3 py-1.5')}>
            <textarea
              ref={areaRef}
              autoFocus
              value={draft}
              aria-label={`Edit ${field.displayName}`}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (cancelled.current) return;
                finish(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelled.current = true;
                  finish(false);
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  cancelled.current = true;
                  finish(true);
                }
              }}
              className="block w-full resize-none overflow-hidden bg-transparent text-reading text-ink-secondary outline-none"
            />
          </div>
        ) : (
          <>
            <div
              // The clamp fade must match the surface it sits on: the app background at rest, the card
              // while hovered or focused (#954 — a fade token that was right on a bare page is wrong
              // the moment a surface appears behind it, in both themes).
              className={cn(
                '-mx-3 px-3 py-1.5 [--fade:var(--bg-app)]',
                !readOnly && cn(BLOCK_SURFACE, 'cursor-text hover:[--fade:var(--bg-card)] focus-within:[--fade:var(--bg-card)]'),
              )}
            >
              <div
                ref={bodyRef}
                role={readOnly ? undefined : 'button'}
                tabIndex={readOnly ? undefined : 0}
                aria-label={readOnly ? undefined : `Edit ${field.displayName}`}
                onClick={readOnly ? undefined : startEdit}
                onKeyDown={
                  readOnly
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          startEdit();
                        }
                      }
                }
                style={!expanded ? { maxHeight: CLAMP_PX } : undefined}
                className={cn('relative outline-none', !expanded && 'overflow-hidden')}
              >
                <MarkdownBody source={text} />
                {overflows && !expanded && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--fade)] to-transparent"
                  />
                )}
              </div>
            </div>
            {overflows && (
              <button
                type="button"
                className="mt-1 rounded px-1 text-label font-medium text-muted hover:bg-hover hover:text-ink"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? 'Show less' : 'Show all'}
              </button>
            )}
          </>
        )}
      </CollapsibleBody>
    </div>
  );
}
