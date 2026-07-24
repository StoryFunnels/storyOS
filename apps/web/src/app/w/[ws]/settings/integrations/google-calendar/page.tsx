'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL, apiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDatabases, useSpaces } from '@/lib/queries';
import { qualifiedDatabaseLabel } from '@/lib/database-labels';

interface Connection {
  id: string;
  provider: string;
  name: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

interface Field {
  id: string;
  display_name: string;
  type: string;
}

interface Calendar {
  id: string;
  name: string;
  primary: boolean;
}

interface Binding {
  id: string;
  connection_id: string;
  database_id: string;
  database_name: string;
  database_space_name: string;
  calendar_name: string;
  start_field_name: string;
  direction: 'push' | 'pull' | 'two_way';
  last_sync_at: string | null;
  last_error: string | null;
}

interface CalendarTemplateResult {
  databases: { calendar: string };
  fields: {
    'calendar.start': string;
    'calendar.end': string;
    'calendar.description': string;
  };
}

const DIRECTION_LABELS = {
  push: 'StoryOS → Google',
  pull: 'Google → StoryOS',
  two_way: 'Two-way',
} as const;
async function calendarApi<T>(ws: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(
    `${API_URL}/api/v1/workspaces/${ws}/integrations/google-calendar${path}`,
    {
      credentials: 'include',
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export default function GoogleCalendarIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [startFieldId, setStartFieldId] = useState('');
  const [endFieldId, setEndFieldId] = useState('');
  const [descriptionFieldId, setDescriptionFieldId] = useState('');
  const [direction, setDirection] = useState<'push' | 'pull' | 'two_way'>('push');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateSpaceId, setTemplateSpaceId] = useState('');
  const [templateName, setTemplateName] = useState('Calendar');
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const pendingTemplateMapping = useRef<{
    databaseId: string;
    start: string;
    end: string;
    description: string;
  } | null>(null);

  const connections = useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Connection[] }).data.filter(
        (item) => item.provider === 'google-calendar',
      );
    },
  });

  const databases = useDatabases(ws);
  const spaces = useSpaces(ws);

  const fields = useQuery({
    queryKey: ['fields', ws, databaseId],
    enabled: Boolean(databaseId),
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{databaseId}/fields',
        { params: { path: { ws, databaseId } } } as never,
      );
      if (error) throw error;
      return (data as unknown as { data: Field[] }).data;
    },
  });

  const calendars = useQuery({
    queryKey: ['google-calendars', ws, connectionId],
    enabled: Boolean(connectionId),
    queryFn: () =>
      calendarApi<{ data: Calendar[] }>(
        ws,
        `/calendars?connection_id=${encodeURIComponent(connectionId)}`,
      ).then((result) => result.data),
  });

  const bindings = useQuery({
    queryKey: ['google-calendar-bindings', ws],
    queryFn: () => calendarApi<{ data: Binding[] }>(ws, '/bindings').then((result) => result.data),
  });

  useEffect(() => {
    if (searchParams.get('connected') === 'google-calendar') {
      toast.success('Google Calendar connected');
    }
  }, [searchParams]);

  useEffect(() => {
    const active = connections.data?.find((item) => item.status === 'active');
    if (active && !connectionId) setConnectionId(active.id);
  }, [connections.data, connectionId]);

  useEffect(() => {
    const template = pendingTemplateMapping.current;
    if (template?.databaseId === databaseId) {
      setStartFieldId(template.start);
      setEndFieldId(template.end);
      setDescriptionFieldId(template.description);
      pendingTemplateMapping.current = null;
      return;
    }
    setStartFieldId('');
    setEndFieldId('');
    setDescriptionFieldId('');
  }, [databaseId]);

  const dateFields = useMemo(
    () => (fields.data ?? []).filter((field) => field.type === 'date'),
    [fields.data],
  );
  const descriptionFields = useMemo(
    () =>
      (fields.data ?? []).filter((field) => field.type === 'text' || field.type === 'rich_text'),
    [fields.data],
  );

  const createBinding = useMutation({
    mutationFn: async () => {
      const calendar = calendars.data?.find((item) => item.id === calendarId);
      if (!calendar) throw new Error('Choose a calendar');
      const binding = await calendarApi<{ id: string }>(ws, '/bindings', {
        method: 'POST',
        body: JSON.stringify({
          connection_id: connectionId,
          database_id: databaseId,
          calendar_id: calendar.id,
          calendar_name: calendar.name,
          start_field_id: startFieldId,
          ...(endFieldId ? { end_field_id: endFieldId } : {}),
          ...(descriptionFieldId ? { description_field_id: descriptionFieldId } : {}),
          direction,
        }),
      });
      const result = await calendarApi<{
        synced: number;
        skipped: number;
        pulled: number;
        deleted: number;
        conflicts: number;
      }>(ws, `/bindings/${binding.id}/sync`, { method: 'POST' });
      return { ...result, id: binding.id };
    },
    onSuccess: async ({ synced, skipped, pulled, deleted, conflicts }) => {
      await queryClient.invalidateQueries({ queryKey: ['google-calendar-bindings', ws] });
      const summary = syncResultText({ synced, skipped, pulled, deleted, conflicts }, true);
      setSyncSummary(summary);
      if (synced + pulled + deleted === 0) toast.info(summary);
      else toast.success(summary);
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not save mapping')),
  });

  const sync = useMutation({
    mutationFn: (id: string) =>
      calendarApi<{
        synced: number;
        skipped: number;
        pulled: number;
        deleted: number;
        conflicts: number;
      }>(ws, `/bindings/${id}/sync`, { method: 'POST' }),
    onSuccess: (result) => {
      const summary = syncResultText(result, false);
      setSyncSummary(summary);
      if (result.synced + result.pulled + result.deleted === 0) toast.info(summary);
      else toast.success(summary);
      void queryClient.invalidateQueries({ queryKey: ['google-calendar-bindings', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Sync failed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      calendarApi<{ deleted: boolean }>(ws, `/bindings/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['google-calendar-bindings', ws] }),
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not remove mapping')),
  });

  const activeConnections = (connections.data ?? []).filter(
    (connection) => connection.status === 'active',
  );
  const createCalendarDatabase = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${API_URL}/api/v1/workspaces/${ws}/templates/calendar/apply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          space_id: templateSpaceId,
          database_name: templateName.trim(),
          include_samples: false,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Database creation failed (${response.status})`);
      }
      return response.json() as Promise<CalendarTemplateResult>;
    },
    onSuccess: async (result) => {
      const newDatabaseId = result.databases.calendar;
      pendingTemplateMapping.current = {
        databaseId: newDatabaseId,
        start: result.fields['calendar.start'],
        end: result.fields['calendar.end'],
        description: result.fields['calendar.description'],
      };
      await queryClient.invalidateQueries({ queryKey: ['databases', ws] });
      setDatabaseId(newDatabaseId);
      setTemplateOpen(false);
      toast.success(`${templateName.trim()} is ready and its fields are mapped`);
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not create Calendar database')),
  });

  function openTemplateDialog() {
    const existingNames = new Set((databases.data ?? []).map((database) => database.name));
    let candidate = 'Calendar';
    let suffix = 2;
    while (existingNames.has(candidate)) candidate = `Calendar ${suffix++}`;
    setTemplateName(candidate);
    setTemplateSpaceId(spaces.data?.[0]?.id ?? '');
    setTemplateOpen(true);
  }

  const hasActiveMapping = (bindings.data ?? []).length > 0;
  const setupSteps = [
    { label: 'Connect account', done: activeConnections.length > 0 },
    { label: 'Choose database & calendar', done: Boolean(databaseId && calendarId) },
    { label: 'Map fields', done: Boolean(startFieldId) },
    { label: 'Initial sync', done: hasActiveMapping },
    {
      label: 'Verify',
      done: Boolean(syncSummary || bindings.data?.some((binding) => binding.last_sync_at)),
    },
  ];

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <Link
        className="text-[12px] text-muted hover:text-ink"
        href={`/w/${ws}/settings/integrations`}
      >
        ← Integrations
      </Link>
      <div className="mt-5 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] bg-hover">
          <CalendarDays className="h-6 w-6 text-ink" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">Google Calendar</h1>
          <p className="text-[13px] text-muted">
            Push dated StoryOS records into a Google calendar.
          </p>
        </div>
      </div>

      <ol className="mt-6 grid gap-2 sm:grid-cols-5">
        {setupSteps.map((step, index) => (
          <li
            key={step.label}
            className="flex items-center gap-2 rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-2 text-[12px] text-muted sm:flex-col sm:items-start"
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                step.done ? 'bg-accent-soft text-ink' : 'bg-hover text-muted'
              }`}
            >
              {step.done ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
            </span>
            {step.label}
          </li>
        ))}
      </ol>

      <div className="mt-4 rounded-[var(--radius-control)] border border-border-default bg-hover px-4 py-3 text-[12px] text-muted">
        Choose one-way push, one-way pull, or two-way sync. Pull and two-way mappings poll Google
        every five minutes; simultaneous edits use last-write-wins and are reported after sync.
      </div>

      {activeConnections.length === 0 ? (
        <div className="mt-6 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
          <p className="text-sm font-medium text-ink">Connect your Google account</p>
          <p className="mt-1 text-[13px] text-muted">
            Calendar access is requested separately from Google sign-in and YouTube.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              window.location.href = `${API_URL}/api/v1/workspaces/${ws}/connections/oauth/google-calendar/start`;
            }}
          >
            Connect Google Calendar
          </Button>
        </div>
      ) : (
        <>
          <section className="mt-6 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
            <h2 className="text-sm font-semibold text-ink">Map a database</h2>
            <p className="mt-1 text-[12px] text-muted">
              New and edited records with a start date sync automatically. Clearing the date or
              deleting the record removes its event.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Google connection"
                value={connectionId}
                onChange={setConnectionId}
                options={activeConnections.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
              <SelectField
                label="Database"
                value={databaseId}
                onChange={setDatabaseId}
                placeholder="Choose database"
                options={(databases.data ?? []).map((item) => ({
                  value: item.id,
                  label: qualifiedDatabaseLabel(item, spaces.data ?? []),
                }))}
                help="Choose a database with a date field, or create the ready-to-sync Calendar template."
              />
              <SelectField
                label="Calendar"
                value={calendarId}
                onChange={setCalendarId}
                placeholder={calendars.isLoading ? 'Loading calendars…' : 'Choose calendar'}
                options={(calendars.data ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.name}${item.primary ? ' (primary)' : ''}`,
                }))}
                help="Only calendars where this account can create events are shown."
              />
              <SelectField
                label="Start date"
                value={startFieldId}
                onChange={setStartFieldId}
                placeholder={databaseId ? 'Choose date field' : 'Choose database first'}
                options={dateFields.map((item) => ({
                  value: item.id,
                  label: item.display_name,
                }))}
                help="Example: Start. Records without this value are skipped."
              />
              <SelectField
                label="End date (optional)"
                value={endFieldId}
                onChange={setEndFieldId}
                placeholder="Default: one hour / one day"
                options={dateFields.map((item) => ({
                  value: item.id,
                  label: item.display_name,
                }))}
                help="Example: End. If empty, events last one hour or one day."
              />
              <SelectField
                label="Description (optional)"
                value={descriptionFieldId}
                onChange={setDescriptionFieldId}
                placeholder="No description"
                options={descriptionFields.map((item) => ({
                  value: item.id,
                  label: item.display_name,
                }))}
                help="Example: Description or Notes. This becomes the Google event body."
              />
              <SelectField
                label="Sync direction"
                value={direction}
                onChange={(value) => setDirection(value as typeof direction)}
                options={[
                  { value: 'push', label: 'StoryOS → Google Calendar' },
                  { value: 'pull', label: 'Google Calendar → StoryOS' },
                  { value: 'two_way', label: 'Two-way (last write wins)' },
                ]}
                help="Pull and two-way sync check Google every five minutes and whenever you press Sync."
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={openTemplateDialog}>
                <Plus className="h-3.5 w-3.5" /> Create Calendar database
              </Button>
              <span className="text-[12px] text-muted">
                Installs Start, End, Description, Status and Location fields plus Calendar and
                Upcoming views.
              </span>
            </div>
            {databaseId && fields.isSuccess && dateFields.length === 0 && (
              <p className="mt-3 rounded-[var(--radius-control)] bg-hover px-3 py-2 text-[12px] text-ink">
                This database has no date fields. Add one, or create the Calendar database above.
              </p>
            )}
            <Button
              className="mt-5"
              disabled={
                !connectionId ||
                !databaseId ||
                !calendarId ||
                !startFieldId ||
                createBinding.isPending
              }
              onClick={() => createBinding.mutate()}
            >
              {createBinding.isPending ? 'Saving and syncing…' : 'Save mapping & sync'}
            </Button>
          </section>

          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-ink">Active mappings</h2>
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
              {(bindings.data ?? []).length === 0 && (
                <p className="px-4 py-6 text-[13px] text-muted">
                  No mappings yet. Complete the fields above; dated records will become Google
                  events after the first sync.
                </p>
              )}
              {(bindings.data ?? []).map((binding) => (
                <div
                  key={binding.id}
                  className="flex items-center justify-between gap-4 border-b border-border-default px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {binding.database_space_name} / {binding.database_name} →{' '}
                      {binding.calendar_name}
                    </p>
                    <p className="text-[12px] text-muted">
                      Start: {binding.start_field_name}
                      {' · '}
                      {DIRECTION_LABELS[binding.direction]}
                      {binding.last_sync_at
                        ? ` · synced ${new Date(binding.last_sync_at).toLocaleString()}`
                        : ''}
                    </p>
                    <Link
                      className="mt-1 inline-block text-[12px] text-primary hover:underline"
                      href={`/w/${ws}/d/${binding.database_id}`}
                    >
                      Open mapped database →
                    </Link>
                    {binding.last_error && (
                      <p className="mt-1 text-[12px] text-error">{binding.last_error}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={sync.isPending}
                      onClick={() => sync.mutate(binding.id)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Sync
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(binding.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
          {syncSummary && (
            <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-control)] border border-border-default bg-accent-soft px-4 py-3 text-[12px] text-ink">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              {syncSummary}
            </div>
          )}
        </>
      )}

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent title="Create a Calendar database">
          <p className="mb-4 text-[13px] text-muted">
            StoryOS will install a maintained event schema and pre-map it for Google Calendar.
          </p>
          <div className="space-y-4">
            <SelectField
              label="Space"
              value={templateSpaceId}
              onChange={setTemplateSpaceId}
              placeholder="Choose space"
              options={(spaces.data ?? []).map((space) => ({
                value: space.id,
                label: space.name,
              }))}
            />
            <div className="space-y-1.5">
              <Label htmlFor="calendar-database-name">Database name</Label>
              <Input
                id="calendar-database-name"
                value={templateName}
                maxLength={100}
                onChange={(event) => setTemplateName(event.target.value)}
              />
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              disabled={
                !templateSpaceId || !templateName.trim() || createCalendarDatabase.isPending
              }
              onClick={() => createCalendarDatabase.mutate()}
            >
              {createCalendarDatabase.isPending ? 'Creating…' : 'Create and map'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <select
        className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-[13px] text-ink outline-none focus:border-border-strong"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder ?? 'Choose'}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {help && <p className="text-[11px] leading-4 text-muted">{help}</p>}
    </div>
  );
}

function syncResultText(
  result: {
    synced: number;
    skipped: number;
    pulled: number;
    deleted: number;
    conflicts: number;
  },
  initial: boolean,
): string {
  const changes = [
    result.synced ? `${result.synced} pushed` : null,
    result.pulled ? `${result.pulled} pulled` : null,
    result.deleted ? `${result.deleted} removed` : null,
    result.skipped ? `${result.skipped} unchanged or undated` : null,
    result.conflicts
      ? `${result.conflicts} conflict${result.conflicts === 1 ? '' : 's'} resolved`
      : null,
  ].filter(Boolean);
  const prefix = initial ? 'Mapping saved.' : 'Sync complete.';
  return changes.length ? `${prefix} ${changes.join('; ')}.` : `${prefix} No changes found.`;
}
