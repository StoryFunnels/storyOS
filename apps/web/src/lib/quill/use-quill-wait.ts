'use client';

import { useEffect, useRef, useState } from 'react';
import { nextQuillWaitChange, quillWaitView, type QuillWaitView } from './quill-wait';

/**
 * #1253 — drives `quillWaitView` from a real `pending` flag. `settled` is false while she is held for her minimum, so a screen can
 * keep its waiting view up until she has been there long enough, instead of swapping to the result 100ms after she appeared.
 */
export function useQuillWait(pending: boolean): QuillWaitView {
  const span = useRef<{ start: number; end: number | null } | null>(null);
  const [, setTick] = useState(0);
  const now = Date.now();

  // The clock starts the moment `pending` turns true and stops the moment it turns false.
  if (pending && (span.current === null || span.current.end !== null)) span.current = { start: now, end: null };
  if (!pending && span.current && span.current.end === null) span.current = { ...span.current, end: now };

  const current = span.current;
  useEffect(() => {
    if (!current) return;
    const at = nextQuillWaitChange(current.start, current.end, Date.now());
    if (at === null) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), Math.max(0, at - Date.now()));
    return () => window.clearTimeout(id);
  });

  if (!current) return { showQuill: false, settled: true };
  return quillWaitView(current.start, current.end, now);
}
