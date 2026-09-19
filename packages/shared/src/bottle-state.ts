// Journey state per spec v0.2 §11. Only the directed-delivery transitions are
// exercised in stage 3; the rest are declared so stage 4/5 add behavior, not states.
export const BOTTLE_STATES = [
  'at_sea',
  'stranded_public',
  'public_expired',
  'delivered',
  'opened',
  'discarded',
  'lost',
  'cancelled',
] as const;
export type BottleState = (typeof BOTTLE_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<BottleState> = new Set([
  'opened',
  'discarded',
  'lost',
  'cancelled',
]);

export const ALLOWED_TRANSITIONS: Readonly<Record<BottleState, readonly BottleState[]>> = {
  at_sea: ['stranded_public', 'lost', 'delivered', 'cancelled'],
  stranded_public: ['at_sea', 'discarded', 'public_expired', 'cancelled'],
  public_expired: [], // D02 open: no approved onward transition
  delivered: ['opened'],
  opened: [],
  discarded: [],
  lost: [],
  cancelled: [],
};

export function canTransition(from: BottleState, to: BottleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: BottleState): boolean {
  return TERMINAL_STATES.has(state);
}

// Why a bottle is Lost. `adrift`: swept off its route in a storm and now drifting in the public
// ocean at its persisted loss position (its delivery is over; public claiming is not built yet).
// `sunk`: gone under at its persisted position — private to the sender. `destroyed` is declared
// by the spec and not produced by any code path yet.
export const LOSS_REASONS = ['adrift', 'sunk', 'destroyed'] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export const MODERATION_STATUSES = ['clear', 'quarantined', 'removed'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export const JOURNEY_EVENT_TYPES = [
  'released',
  'storm_exposure',
  'stranded',
  'rescued',
  'discarded',
  'public_expired',
  'lost',
  'delivered',
  'opened',
  'cancelled',
  'route_revised',
] as const;
export type JourneyEventType = (typeof JOURNEY_EVENT_TYPES)[number];
