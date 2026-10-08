'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { useTheme } from '@/lib/theme';
import { uploadEditorImage } from '@/lib/editor-upload';
import type { Field } from '@/components/table-view/use-table-data';
import { MarkdownActions } from './markdown-actions';
import { MentionScope, MentionSuggestionMenus, mentionSchema } from './mentions';
import { FieldMenu } from './field-controls';
import { CollapseToggle, CollapsibleBody, useCollapsedSection } from './collapsible-section';
import { isEmptyBlocks } from './entity-field-utils';
import type { Zone } from './entity-field-utils';

/** Full-width BlockNote section for a rich_text field (MN-041). */
export function RichTextFieldSection({
  ws,
  db,
  field,
  value,
  readOnly,
  schemaEditable,
  onToggleZone,
  onCommit,
}: {
  ws: string;
  db: string;
  field: Field;
  value: unknown;
  readOnly: boolean;
  schemaEditable: boolean;
  onToggleZone: (field: Field, zone: Zone) => void;
  onCommit: (value: unknown) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #309 — fold a long field away. Keyed per database+field, so the preference
  // holds across records rather than resetting on every one.
  const { collapsed, toggle } = useCollapsedSection(db, field.id);
  const { resolved: theme } = useTheme();
  const editor = useCreateBlockNote({
    schema: mentionSchema,
    initialContent: Array.isArray(value) && value.length > 0 ? (value as never) : undefined,
    uploadFile: (file: File) => uploadEditorImage(ws, file),
  });
  // #834 — closing the record (the X, or now Esc) used to DISCARD an edit still waiting in
  // the 800 ms debounce: type, close within the window, and the last words were gone. A
  // keyboard close makes that window easy to hit, so a pending save is FLUSHED on unmount
  // instead — closing is never a way to lose input.
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
      try {
        const doc = editorRef.current.document;
        commitRef.current(doc.length > 0 ? doc : null);
      } catch {
        /* the editor was already torn down; there is nothing left to read */
      }
    },
    [],
  );

  // #813 — an EMPTY rich-text field is one quiet line, not a full editor box:
  // Rule 3 (#780) "empty sections do not render", with the discoverability
  // exception — the name stays and one click opens the editor with the cursor in
  // it. Read-only viewers cannot fill it, so for them there is nothing to offer
  // and it does not render at all.
  const [opened, setOpened] = useState(false);
  const quiet = isEmptyBlocks(value) && !opened;
  useEffect(() => {
    if (opened) setTimeout(() => editor.focus(), 0);
  }, [opened, editor]);
  if (quiet) {
    if (readOnly) return null;
    return (
      <button
        type="button"
        onClick={() => setOpened(true)}
        className="group mb-1 flex h-6 items-center gap-1.5 rounded-[var(--radius-control)] px-1 text-label font-medium uppercase tracking-wider text-muted hover:bg-hover hover:text-ink"
      >
        <Plus className="h-3 w-3 text-faint group-hover:text-ink" aria-hidden />
        {field.displayName}
      </button>
    );
  }

  return (
    <div
      className="group mb-5"
      // Opened but left empty: fold back to the quiet line instead of leaving a
      // blank box behind. Focus moving to an editor menu (slash/mention) is
      // inside the container's descendants only while typing, i.e. not empty.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && isEmptyBlocks(editor.document)) {
          setOpened(false);
        }
      }}
    >
      <div className="mb-1.5 flex items-center gap-1">
        <CollapseToggle collapsed={collapsed} onToggle={toggle} label={field.displayName} />
        <h2 className="text-label font-medium uppercase tracking-wider text-muted">{field.displayName}</h2>
        {schemaEditable && <FieldMenu ws={ws} db={db} field={field} onToggleZone={onToggleZone} collection />}
        <span className="ml-auto">
          <MarkdownActions editor={editor} filename={field.displayName} />
        </span>
      </div>
      <CollapsibleBody collapsed={collapsed}>
      <div className="rounded-[var(--radius-card)] border border-border-default bg-card py-3 [&_.bn-editor]:bg-transparent">
        <MentionScope ws={ws}>
          <BlockNoteView
            /* #338: BlockNote mounts its own "/" menu unless this is off, and
               it wins over ours — so the reordered menu in MentionSuggestionMenus
               never rendered until this was set. Verified in the browser: group
               order stayed BlockNote's default with Emoji last at 22 of 23. */
            slashMenu={false}
            editor={editor}
            editable={!readOnly}
            theme={theme}
            onChange={() => {
              if (readOnly) return;
              if (timer.current !== null) clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                const doc = editor.document;
                onCommit(doc.length > 0 ? doc : null);
              }, 800);
            }}
          >
            <MentionSuggestionMenus editor={editor as never} ws={ws} />
          </BlockNoteView>
        </MentionScope>
      </div>
      </CollapsibleBody>
    </div>
  );
}
