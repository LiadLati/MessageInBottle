// Journey state (docs/SeaYou_Product_Specification.md §11, "As built", and §9.2–9.3): only the
// states the server actually writes (audit ARCH-025). A bottle is at sea, then either delivered
// (and later opened) or lost; a block, an inactive recipient or an account deletion cancels one
// that has not arrived. The earlier design's states `stranded_public`, `public_expired` and
// `discarded` were never produced by any code path and are gone: an adrift bottle is `lost`
// with loss reason `adrift`, and its public listing is tracked by `public_deadline_at` /
// `public_expired_at`.
export const BOTTLE_STATES = ['at_sea', 'delivered', 'opened', 'lost', 'cancelled'] as const;
export type BottleState = (typeof BOTTLE_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<BottleState> = new Set(['opened', 'lost', 'cancelled']);

export const ALLOWED_TRANSITIONS: Readonly<Record<BottleState, readonly BottleState[]>> = {
  at_sea: ['lost', 'delivered', 'cancelled'],
  delivered: ['opened'],
  opened: [],
  lost: [],
  cancelled: [],
};

export function canTransition(from: BottleState, to: BottleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: BottleState): boolean {
  return TERMINAL_STATES.has(state);
}

// Why a bottle is Lost. `adrift`: swept off its route in a storm and listed in the public ocean
// at its persisted loss position for 72 hours. `sunk`: gone under at its persisted position —
// private to the sender.
export const LOSS_REASONS = ['adrift', 'sunk'] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export const MODERATION_STATUSES = ['clear', 'quarantined', 'removed'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export const JOURNEY_EVENT_TYPES = [
  'released',
  'storm_exposure',
  'public_expired',
  'lost',
  'delivered',
  'opened',
  'cancelled',
  'route_revised',
] as const;
export type JourneyEventType = (typeof JOURNEY_EVENT_TYPES)[number];
