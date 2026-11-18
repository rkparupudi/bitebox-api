/**
 * The order lifecycle as an explicit state machine. Every status change in the app goes
 * through canTransition(), so there's exactly one place to read (and test) the rules.
 *
 *   PENDING_PAYMENT ──(Stripe webhook)──▶ PLACED ─▶ CONFIRMED ─▶ PREPARING
 *         │                                │            │             │
 *         ▼                                ▼            ▼             ▼
 *     CANCELLED ◀──────────────────────────┴────────────┘     READY_FOR_PICKUP
 *                                                                     │
 *                                                OUT_FOR_DELIVERY ◀───┘
 *                                                        │
 *                                                    DELIVERED
 */
export enum OrderStatus {
  PENDING_PAYMENT = 'pending_payment',
  PLACED = 'placed',
  CONFIRMED = 'confirmed',
  PREPARING = 'preparing',
  READY_FOR_PICKUP = 'ready_for_pickup',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

/** Who is asking for the change. "system" is the payment webhook or internal cleanup. */
export type Actor = 'customer' | 'restaurant' | 'admin' | 'system';

type Rules = Partial<Record<OrderStatus, Actor[]>>;

const TRANSITIONS: Record<OrderStatus, Rules> = {
  [OrderStatus.PENDING_PAYMENT]: {
    [OrderStatus.PLACED]: ['system'],
    [OrderStatus.CANCELLED]: ['customer', 'admin', 'system'],
  },
  [OrderStatus.PLACED]: {
    [OrderStatus.CONFIRMED]: ['restaurant', 'admin'],
    // A customer can cancel until the restaurant accepts; the restaurant can reject.
    [OrderStatus.CANCELLED]: ['customer', 'restaurant', 'admin'],
  },
  [OrderStatus.CONFIRMED]: {
    [OrderStatus.PREPARING]: ['restaurant', 'admin'],
    [OrderStatus.CANCELLED]: ['restaurant', 'admin'],
  },
  [OrderStatus.PREPARING]: {
    [OrderStatus.READY_FOR_PICKUP]: ['restaurant', 'admin'],
  },
  [OrderStatus.READY_FOR_PICKUP]: {
    [OrderStatus.OUT_FOR_DELIVERY]: ['restaurant', 'admin'],
  },
  [OrderStatus.OUT_FOR_DELIVERY]: {
    [OrderStatus.DELIVERED]: ['restaurant', 'admin'],
  },
  [OrderStatus.DELIVERED]: {},
  [OrderStatus.CANCELLED]: {},
};

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

export const TERMINAL_STATUSES = [OrderStatus.DELIVERED, OrderStatus.CANCELLED];

/** Statuses a restaurant should see. Unpaid orders aren't real orders yet. */
export const RESTAURANT_VISIBLE_STATUSES: OrderStatus[] = Object.values(OrderStatus).filter(
  (s) => s !== OrderStatus.PENDING_PAYMENT,
);
