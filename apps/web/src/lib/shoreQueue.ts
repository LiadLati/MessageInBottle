import type { ShoreBottleDto } from '@mib/shared';

// The shore shows sealed bottles only. One is featured (the "Pick it up" card); the rest wait in
// a list. Choosing a waiting bottle swaps it into the featured slot and never opens anything —
// opening is only ever the explicit "Pick it up" press.
export function sealedOnly(bottles: ShoreBottleDto[]): ShoreBottleDto[] {
  return bottles.filter((b) => b.state === 'delivered');
}

export function featuredBottle(
  sealed: ShoreBottleDto[],
  selectedId: string | null,
): ShoreBottleDto | null {
  return sealed.find((b) => b.id === selectedId) ?? sealed[0] ?? null;
}

export function waitingBottles(
  sealed: ShoreBottleDto[],
  featured: ShoreBottleDto | null,
): ShoreBottleDto[] {
  return sealed.filter((b) => b.id !== featured?.id);
}
