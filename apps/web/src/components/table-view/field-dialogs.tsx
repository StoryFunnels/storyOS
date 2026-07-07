'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OPTION_COLORS } from './cells';
import type { Field } from './use-table-data';

const CREATABLE_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'date', label: 'Date' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'user', label: 'Person' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'relation', label: 'Relation → another database' },
] as const;

/** Conversions the API allows (docs/architecture/record-storage.md). */
const CONVERTIBLE: Record<string, string[]> = {
  text: ['number', 'date'],
  number: ['text'],
  checkbox: ['text'],
  date: ['text'],
  select: ['text', 'multi_select'],
  multi_select: ['text', 'select'],
  url: ['text', 'email'],
  email: ['text', 'url'],
  user: [],
};

export function useFieldMutations(ws: string, db: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['database', ws, db] });
    void qc.invalidateQueries({ queryKey: ['records', ws, db] });
  };
  return { invalidate, ws, db, qc };
}

interface OptionDraft {
  label: string;
  color: string;
}

export function AddFieldDialog({
  ws,
  db,
  onDone,
}: {
  ws: string;
  db: string;
  onDone: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('text');
  const [multiline, setMultiline] = useState(false);
  const [includeTime, setIncludeTime] = useState(false);
  const [multiUser, setMultiUser] = useState(false);
  const [numberFormat, setNumberFormat] = useState('plain');
  const [options, setOptions] = useState<OptionDraft[]>([{ label: '', color: 'gray' }]);
  const [targetDb, setTargetDb] = useState('');
  const [singleTarget, setSingleTarget] = useState(true);
  const [inverseName, setInverseName] = useState('');
  const databases = useDatabases(ws);

  const create = useMutation({
    mutationFn: async () => {
      if (type === 'relation') {
        const { error } = await api.POST('/api/v1/workspaces/{ws}/relations', {
          params: { path: { ws } },
          body: {
            database_a_id: db,
            database_b_id: targetDb,
            cardinality: singleTarget ? 'one_to_many' : 'many_to_many',
            field_a_name: name,
            ...(inverseName.trim() ? { field_b_name: inverseName.trim() } : {}),
          },
        });
        if (error) throw error;
        return;
      }
      const config: Record<string, unknown> = {};
      if (type === 'text') config.multiline = multiline;
      if (type === 'date') config.include_time = includeTime;
      if (type === 'user') config.multi = multiUser;
      if (type === 'number') config.format = numberFormat;
      const body: Record<string, unknown> = { display_name: name, type, config };
      if (type === 'select' || type === 'multi_select') {
        body.options = options.filter((o) => o.label.trim());
      }
      const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/fields', {
        params: { path: { ws, db } },
        body: body as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: () => toast.error('Could not create the field'),
  });

  const isSelect = type === 'select' || type === 'multi_select';

  return (
    <DialogContent title="Add field">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="field-name">Name</Label>
          <Input id="field-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="field-type">Type</Label>
          <select
            id="field-type"
            className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {CREATABLE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {type === 'text' && (
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} />
            Multi-line
          </label>
        )}
        {type === 'date' && (
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} />
            Include time
          </label>
        )}
        {type === 'user' && (
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={multiUser} onChange={(e) => setMultiUser(e.target.checked)} />
            Allow multiple people
          </label>
        )}
        {type === 'number' && (
          <div className="flex flex-col gap-1.5">
            <Label>Format</Label>
            <select
              className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
              value={numberFormat}
              onChange={(e) => setNumberFormat(e.target.value)}
            >
              <option value="plain">Plain</option>
              <option value="percent">Percent</option>
              <option value="currency">Currency</option>
            </select>
          </div>
        )}
        {isSelect && (
          <div className="flex flex-col gap-1.5">
            <Label>Options</Label>
            <OptionsEditor options={options} onChange={setOptions} />
          </div>
        )}
        {type === 'relation' && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="target-db">Related database</Label>
              <select
                id="target-db"
                required
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                value={targetDb}
                onChange={(e) => setTargetDb(e.target.value)}
              >
                <option value="" disabled>
                  Pick a database…
                </option>
                {(databases.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Each record here links to…</Label>
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="radio" checked={singleTarget} onChange={() => setSingleTarget(true)} />
                one target record (one-to-many)
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="radio" checked={!singleTarget} onChange={() => setSingleTarget(false)} />
                many target records (many-to-many)
              </label>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inverse-name">Field name on the other side (optional)</Label>
              <Input
                id="inverse-name"
                placeholder="defaults to this database's name"
                value={inverseName}
                onChange={(e) => setInverseName(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={create.isPending || (type === 'relation' && !targetDb)}>
            Add field
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: OptionDraft[];
  onChange: (options: OptionDraft[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((option, i) => (
        <div key={i} className="flex items-center gap-2">
          <select
            className="h-8 w-20 rounded-[var(--radius-control)] border border-border-default bg-card px-1 text-[12px]"
            value={option.color}
            onChange={(e) => onChange(options.map((o, j) => (j === i ? { ...o, color: e.target.value } : o)))}
            style={{ color: OPTION_COLORS[option.color] }}
          >
            {Object.keys(OPTION_COLORS).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Input
            className="h-8"
            placeholder={`Option ${i + 1}`}
            value={option.label}
            onChange={(e) => onChange(options.map((o, j) => (j === i ? { ...o, label: e.target.value } : o)))}
          />
          <button
            type="button"
            className="p-1 text-faint hover:text-error"
            onClick={() => onChange(options.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="flex items-center gap-1 self-start text-[13px] text-muted hover:text-ink"
        onClick={() => onChange([...options, { label: '', color: 'gray' }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add option
      </button>
    </div>
  );
}

export function EditFieldDialog({
  ws,
  db,
  field,
  onDone,
}: {
  ws: string;
  db: string;
  field: Field;
  onDone: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const [name, setName] = useState(field.displayName);

  const rename = useMutation({
    mutationFn: async () => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: field.id } },
        body: { display_name: name },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });

  const addOption = useMutation({
    mutationFn: async (label: string) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options',
        { params: { path: { ws, db, field: field.id } }, body: { label } },
      );
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const patchOption = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; label?: string; color?: string }) => {
      const { error } = await api.PATCH(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
        { params: { path: { ws, db, field: field.id, option: id } }, body: body as never },
      );
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const removeOption = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.DELETE(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
        { params: { path: { ws, db, field: field.id, option: id } }, body: { confirm: false } },
      );
      if (res.error) {
        const message = (res.error as { error?: { message?: string } }).error?.message ?? '';
        if (message.includes('confirm')) {
          if (window.confirm(`${message.split('.')[0]}. Clear it from those records?`)) {
            const forced = await api.DELETE(
              '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/options/{option}',
              { params: { path: { ws, db, field: field.id, option: id } }, body: { confirm: true } },
            );
            if (forced.error) throw forced.error;
            return;
          }
          return;
        }
        throw res.error;
      }
    },
    onSuccess: invalidate,
  });

  const isSelect = field.type === 'select' || field.type === 'multi_select';
  const [newOption, setNewOption] = useState('');

  return (
    <DialogContent title={`Edit "${field.displayName}"`}>
      <div className="flex flex-col gap-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="rename">Name</Label>
            <Input id="rename" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" variant="secondary" disabled={name === field.displayName}>
            Rename
          </Button>
        </form>
        <p className="text-[12px] text-faint">
          API name <code className="text-muted">{field.apiName}</code> stays stable across renames.
        </p>

        {isSelect && (
          <div className="flex flex-col gap-2">
            <Label>Options</Label>
            {(field.options ?? []).map((option) => (
              <div key={option.id} className="flex items-center gap-2">
                <select
                  className="h-8 w-20 rounded-[var(--radius-control)] border border-border-default bg-card px-1 text-[12px]"
                  value={option.color}
                  onChange={(e) => patchOption.mutate({ id: option.id, color: e.target.value })}
                  style={{ color: OPTION_COLORS[option.color] }}
                >
                  {Object.keys(OPTION_COLORS).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <Input
                  className="h-8"
                  defaultValue={option.label}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== option.label) {
                      patchOption.mutate({ id: option.id, label: e.target.value.trim() });
                    }
                  }}
                />
                <button
                  type="button"
                  className="p-1 text-faint hover:text-error"
                  onClick={() => removeOption.mutate(option.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newOption.trim()) {
                  addOption.mutate(newOption.trim());
                  setNewOption('');
                }
              }}
            >
              <Input
                className="h-8"
                placeholder="New option"
                value={newOption}
                onChange={(e) => setNewOption(e.target.value)}
              />
              <Button type="submit" variant="secondary" size="sm">
                Add
              </Button>
            </form>
          </div>
        )}

        <div className="flex justify-end">
          <DialogClose asChild>
            <Button type="button">Done</Button>
          </DialogClose>
        </div>
      </div>
    </DialogContent>
  );
}

export function ChangeTypeDialog({
  ws,
  db,
  field,
  onDone,
}: {
  ws: string;
  db: string;
  field: Field;
  onDone: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);
  const targets = CONVERTIBLE[field.type] ?? [];
  const [target, setTarget] = useState(targets[0] ?? '');
  const [dryRun, setDryRun] = useState<{ records_affected: number; lossy_conversions: number } | null>(null);

  const check = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/change-type',
        {
          params: { path: { ws, db, field: field.id } },
          body: { type: target as never, dry_run: true },
        },
      );
      if (error) throw error;
      return data as unknown as { records_affected: number; lossy_conversions: number };
    },
    onSuccess: setDryRun,
  });

  const apply = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/change-type',
        { params: { path: { ws, db, field: field.id } }, body: { type: target as never } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success('Type changed');
      onDone();
    },
  });

  if (targets.length === 0) {
    return (
      <DialogContent title="Change type">
        <p className="text-sm text-muted">
          {field.type} fields cannot be converted. Delete the field and create a new one instead.
        </p>
        <div className="mt-4 flex justify-end">
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent title={`Change "${field.displayName}" type`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Convert {field.type} to</Label>
          <select
            className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setDryRun(null);
            }}
          >
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {dryRun ? (
          <p className="text-[13px] text-ink-secondary">
            {dryRun.records_affected} record(s) will convert.{' '}
            {dryRun.lossy_conversions > 0 ? (
              <span className="text-warning">
                {dryRun.lossy_conversions} value(s) cannot convert and will be cleared.
              </span>
            ) : (
              'No values will be lost.'
            )}
          </p>
        ) : (
          <p className="text-[13px] text-muted">Run the check to see what this conversion affects.</p>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          {dryRun ? (
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
              Convert
            </Button>
          ) : (
            <Button onClick={() => check.mutate()} disabled={check.isPending}>
              Check impact
            </Button>
          )}
        </div>
      </div>
    </DialogContent>
  );
}

export function useDeleteField({
  ws,
  db,
  field,
  onDone,
}: {
  ws: string;
  db: string;
  field: Field;
  onDone: () => void;
}) {
  const { invalidate } = useFieldMutations(ws, db);

  const del = useMutation({
    mutationFn: async () => {
      const usage = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/fields/{field}/usage',
        { params: { path: { ws, db, field: field.id } } },
      );
      const count = (usage.data as { records_with_value: number } | undefined)?.records_with_value ?? 0;
      if (
        !window.confirm(
          count > 0
            ? `"${field.displayName}" has values on ${count} record(s). Delete anyway?`
            : `Delete "${field.displayName}"?`,
        )
      ) {
        return false;
      }
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
        params: { path: { ws, db, field: field.id } },
      });
      if (error) throw error;
      return true;
    },
    onSuccess: (deleted) => {
      if (deleted) {
        invalidate();
        toast.success('Field deleted');
      }
      onDone();
    },
    onError: () => {
      toast.error('This field cannot be deleted');
      onDone();
    },
  });

  return del;
}
