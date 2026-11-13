import { Injector, Logger, OrderProcess, OrderState } from '@vendure/core';
import { FraudPreventionService } from './fraud-prevention.service';

const loggerCtx = 'FraudPrevention';

let service: FraudPreventionService | null = null;

/**
 * Hold mode's enforcement point (free; enforce mode uses it too). Vendure
 * charges a payment only while the order is in ArrangingPayment, so the move
 * into that state is the last moment an order can be stopped before any money
 * is taken. A block-level order (or an address in its failed-payment cooldown)
 * gets a neutral error from `transitionOrderToState` and cannot add a payment.
 *
 * Shop API only (an admin preparing a draft order is never refused) and FAIL
 * OPEN: any error inside the check lets the transition through.
 */
export const fraudPreChargeProcess: OrderProcess<OrderState> = {
    init(injector: Injector) {
        service = injector.get(FraudPreventionService);
    },
    async onTransitionStart(fromState, toState, data) {
        if (toState !== 'ArrangingPayment' || !service) return;
        try {
            if (data.ctx.apiType !== 'shop') return;
            const r = await service.preChargeCheck(data.ctx, data.order);
            if (!r.allowed) return r.message || 'We could not accept this order.';
        } catch (e: any) {
            Logger.warn(`Pre-charge check failed open: ${e?.message || e}`, loggerCtx);
        }
        return;
    },
};
