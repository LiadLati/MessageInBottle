import { formatClock, formatDateOnly, formatDateTime, sameDay } from '@mib/shared';

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

// Every user-facing date goes through the shared English formatter ("26 Oct 2026, 17:35"),
// never the browser's language (manual review round 1). The device's zone picks the wall clock.
export function formatDate(iso: string): string {
  return formatDateTime(iso);
}

export function formatDay(iso: string): string {
  return formatDateOnly(iso);
}

export function formatTime(iso: string): string {
  return formatClock(iso);
}

export function formatDayTime(iso: string): string {
  return sameDay(iso, Date.now()) ? `today, ${formatClock(iso)}` : formatDateTime(iso);
}

export function initials(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
