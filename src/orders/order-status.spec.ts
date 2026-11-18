import { OrderStatus as S, canTransition } from './order-status';

describe('order state machine', () => {
  it('only the payment webhook can mark an order as paid', () => {
    expect(canTransition(S.PENDING_PAYMENT, S.PLACED, 'system')).toBe(true);
    expect(canTransition(S.PENDING_PAYMENT, S.PLACED, 'customer')).toBe(false);
    expect(canTransition(S.PENDING_PAYMENT, S.PLACED, 'admin')).toBe(false);
  });

  it('restaurant drives the happy path in order', () => {
    const path = [S.PLACED, S.CONFIRMED, S.PREPARING, S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY, S.DELIVERED];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1], 'restaurant')).toBe(true);
    }
  });

  it('cannot skip steps', () => {
    expect(canTransition(S.PLACED, S.DELIVERED, 'restaurant')).toBe(false);
    expect(canTransition(S.CONFIRMED, S.OUT_FOR_DELIVERY, 'restaurant')).toBe(false);
  });

  it('customer can cancel only before the restaurant accepts', () => {
    expect(canTransition(S.PENDING_PAYMENT, S.CANCELLED, 'customer')).toBe(true);
    expect(canTransition(S.PLACED, S.CANCELLED, 'customer')).toBe(true);
    expect(canTransition(S.CONFIRMED, S.CANCELLED, 'customer')).toBe(false);
  });

  it('nothing leaves a terminal state', () => {
    for (const to of Object.values(S)) {
      for (const actor of ['customer', 'restaurant', 'admin', 'system'] as const) {
        expect(canTransition(S.DELIVERED, to, actor)).toBe(false);
        expect(canTransition(S.CANCELLED, to, actor)).toBe(false);
      }
    }
  });
});
