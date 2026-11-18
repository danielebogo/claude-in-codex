import { ResourceBudget } from './resourceBudget.js';

/** Reserves shared headroom before native work can need a full-history continuation. */
export function reserveContinuation(parentBudget, requestedBytes) {
  let reservation = parentBudget.acquire(requestedBytes);
  let active = true;

  const budget = new ResourceBudget(parentBudget.capacity, {
    onGrow(amount) {
      const needed = budget.used + amount;
      const held = reservation?.bytes() ?? 0;
      if (needed <= held) return;
      // Charge the parent first so rejected growth leaves both budgets unchanged.
      if (reservation) reservation.grow(needed - held);
      else reservation = parentBudget.acquire(needed);
    },
    onRelease() {
      trimReservation();
    },
  });

  function trimReservation() {
    const needed = active ? Math.max(requestedBytes, budget.used) : budget.used;
    if (!reservation) return;
    if (needed === 0) {
      reservation.release();
      reservation = null;
      return;
    }
    reservation.shrink(reservation.bytes() - needed);
  }

  return {
    budget,
    close() {
      if (!active) return;
      active = false;
      // Responses and send queues may outlive native cleanup; retain their bytes.
      trimReservation();
    },
  };
}
