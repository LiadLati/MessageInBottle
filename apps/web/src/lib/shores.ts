import type { ShoreDto } from '@mib/shared';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

// Harbour name and sea only, accent-insensitively ("Malaga" finds Málaga). Country names are
// never part of the user-facing app (spec §6.2), so they are not searchable either.
export function matchesShore(shore: Pick<ShoreDto, 'name' | 'sea'>, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return [shore.name, shore.sea ?? ''].some((v) => fold(v).includes(q));
}

// "North Atlantic · 5 places"; the original fictional shores have no sea attribution.
export function describeShore(shore: Pick<ShoreDto, 'sea' | 'capacity'>): string {
  return `${shore.sea ?? 'App anchor'} · ${shore.capacity} places`;
}
