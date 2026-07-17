'use client';

import { useEffect, useRef } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { useTheme } from '@/lib/theme';
import { uploadEditorImage } from '@/lib/editor-upload';
import type { Field } from '@/components/table-view/use-table-data';
import { MarkdownActions } from './markdown-actions';
import { MentionScope, MentionSuggestionMenus, mentionSchema } from './mentions';
import { FieldMenu } from './field-controls';
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
  const { resolved: theme } = useTheme();
  const editor = useCreateBlockNote({
    schema: mentionSchema,
    initialContent: Array.isArray(value) && value.length > 0 ? (value as never) : undefined,
    uploadFile: (file: File) => uploadEditorImage(ws, file),
  });
  useEffect(() => () => (timer.current !== null ? clearTimeout(timer.current) : undefined), []);

  return (
    <div className="group mb-5">
      <div className="mb-1.5 flex items-center gap-1">
        <h2 className="text-[12px] font-medium uppercase tracking-wider text-faint">{field.displayName}</h2>
        {schemaEditable && <FieldMenu ws={ws} db={db} field={field} onToggleZone={onToggleZone} collection />}
        <span className="ml-auto">
          <MarkdownActions editor={editor} filename={field.displayName} />
        </span>
      </div>
      <div className="rounded-[var(--radius-card)] border border-border-default bg-card py-3 [&_.bn-editor]:bg-transparent">
        <MentionScope ws={ws}>
          <BlockNoteView
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
    </div>
  );
}
