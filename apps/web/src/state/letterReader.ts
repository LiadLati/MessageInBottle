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

// A finder's one reading is owned by the server: open for 15 minutes from the opening, then
// gone. On this side (audit FE-R-002):
//   dismiss — closing the reader, a backdrop tap or Escape — only hides it. Nothing is sent;
//            the letter can be returned to while the server still holds the reading;
//   finish  — the explicit, confirmed "Finish reading" — ends it on the server at once;
//   resume  — asks the server: the reading comes back if it is still open, and otherwise this
//            says it has ended (its window ran out);
//   a reload, or a dropped connection, brings an open reading straight back.
export function useLetterReader() {
  const [reading, setReading] = useState<Reading | null>(null);
  const [paused, setPaused] = useState<OpenedLetterDto | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .activeReading()
      .then((r) => {
        if (alive && r.reading) setReading({ letter: r.reading, justOpened: true });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The reading on screen, read by the callbacks below without side effects inside state updates
  // (a development build calls updaters twice).
  const current = useRef<Reading | null>(null);
  useEffect(() => {
    current.current = reading;
  }, [reading]);

  const show = useCallback((r: Reading) => {
    setPaused(null);
    setEnded(false);
    setReading(r);
  }, []);
  const dismiss = useCallback(() => {
    const r = current.current;
    setReading(null);
    setPaused(isFound(r) ? r!.letter : null);
  }, []);
  const finish = useCallback(() => {
    const r = current.current;
    setReading(null);
    setPaused(null);
    if (isFound(r)) void api.closeReading(r!.letter.bottle.id).catch(() => {});
  }, []);
  const resume = useCallback(() => {
    setEnded(false);
    void api
      .activeReading()
      .then((r) => {
        setPaused(null);
        if (r.reading) setReading({ letter: r.reading, justOpened: false });
        else setEnded(true);
      })
      .catch(() => {});
  }, []);
  const forgetEnded = useCallback(() => setEnded(false), []);

  // A reading closed for now lapses with its window: the offer to return becomes "ended".
  const pausedUntil = paused?.readingExpiresAt ? Date.parse(paused.readingExpiresAt) : null;
  useEffect(() => {
    if (pausedUntil === null || !Number.isFinite(pausedUntil)) return;
    const id = window.setTimeout(
      () => {
        setPaused(null);
        setEnded(true);
      },
      Math.max(0, pausedUntil - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [pausedUntil]);

  return { reading, paused, ended, show, dismiss, finish, resume, forgetEnded };
}
