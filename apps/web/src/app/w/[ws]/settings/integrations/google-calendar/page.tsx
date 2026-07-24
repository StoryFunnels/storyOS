'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL, apiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
  database_name: string;
  database_space_name: string;
  calendar_name: string;
  start_field_name: string;
  last_sync_at: string | null;
  last_error: string | null;
}

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
      return calendarApi<{ id: string }>(ws, '/bindings', {
        method: 'POST',
        body: JSON.stringify({
          connection_id: connectionId,
          database_id: databaseId,
          calendar_id: calendar.id,
          calendar_name: calendar.name,
          start_field_id: startFieldId,
          ...(endFieldId ? { end_field_id: endFieldId } : {}),
          ...(descriptionFieldId ? { description_field_id: descriptionFieldId } : {}),
        }),
      });
    },
    onSuccess: async ({ id }) => {
      toast.success('Calendar mapping saved');
      await queryClient.invalidateQueries({ queryKey: ['google-calendar-bindings', ws] });
      const result = await calendarApi<{ synced: number; skipped: number }>(
        ws,
        `/bindings/${id}/sync`,
        { method: 'POST' },
      );
      toast.success(`Initial sync complete: ${result.synced} event(s) pushed`);
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not save mapping')),
  });

  const sync = useMutation({
    mutationFn: (id: string) =>
      calendarApi<{ synced: number; skipped: number }>(ws, `/bindings/${id}/sync`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      toast.success(`Synced ${result.synced}; skipped ${result.skipped} unchanged/undated`);
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
              />
            </div>
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
                <p className="px-4 py-6 text-[13px] text-muted">No mappings yet.</p>
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
                      {binding.last_sync_at
                        ? ` · synced ${new Date(binding.last_sync_at).toLocaleString()}`
                        : ''}
                    </p>
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
        </>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
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
    </div>
  );
}
