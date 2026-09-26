import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenedLetterDto } from '@mib/shared';
import { api } from '../api/client.js';

// The letter reader over the Ocean: the sender re-reading their own letter (a pure read), or a
// finder reading the bottle they have just opened adrift (a one-time reading).
export interface Reading {
  letter: OpenedLetterDto;
  justOpened: boolean;
  // Only the sender's own read needs a line of its own; a found letter carries no attribution
  // and the reader states that itself.
  provenance?: string;
}

const isFound = (r: Reading | null) => r !== null && r.letter.bottle.source === 'public';

// A finder's reading is one reading, once (product decision 12, amended 2026-09-26). The server
// serves the letter in the opening response and never again, so nothing here can bring it back:
//   finish — the explicit, confirmed "Finish reading" — ends it and tells the server;
//   leaving the Ocean ends it too, and a reload or closing the tab loses it for good, so the
//   browser is asked to warn before either while a found letter is open.
// The sender re-reading their own letter is a plain read: closing it just closes it.
export function useLetterReader() {
  const [reading, setReading] = useState<Reading | null>(null);
  // The reading on screen, read by the callbacks below without side effects inside state updates.
  const current = useRef<Reading | null>(null);
  useEffect(() => {
    current.current = reading;
  }, [reading]);

  const show = useCallback((r: Reading) => setReading(r), []);
  const close = useCallback(() => setReading(null), []);
  const finish = useCallback(() => {
    const r = current.current;
    setReading(null);
    if (isFound(r)) void api.closeReading(r!.letter.bottle.id).catch(() => {});
  }, []);

  // Leaving the Ocean with a found letter open ends that reading.
  useEffect(
    () => () => {
      const r = current.current;
      if (isFound(r)) void api.closeReading(r!.letter.bottle.id).catch(() => {});
    },
    [],
  );
  // A reload would lose the one reading for good: ask the browser to confirm first.
  const found = isFound(reading);
  useEffect(() => {
    if (!found) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [found]);

  return { reading, show, close, finish };
}
