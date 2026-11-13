import { RequestContext, VendureEvent } from '@vendure/core';
import type { FraudAssessment } from './types';

/**
 * Extension events on Vendure's EventBus, for host code and other plugins:
 *
 *   eventBus.ofType(FraudAssessedEvent).subscribe(e => …)
 *
 * They carry the score and the signals, never a licence or SMTP detail. A
 * subscriber that throws does not affect the order (the EventBus isolates
 * subscribers); the plugin itself never waits on them.
 */

/** What the event says about the record that was scored. */
export interface FraudEventSubject {
    channelId: number;
    orderId?: number;
    orderCode?: string;
    email?: string;
    ip?: string;
    /** Minor units of `currencyCode`. */
    orderValue: number;
    currencyCode?: string;
}

/**
 * An order was scored. `stage`:
 *  - `pre-charge` at the move to ArrangingPayment (before any payment),
 *  - `placed` after OrderPlacedEvent (the full assessment, card checks included),
 *  - `unpaid` an order left in ArrangingPayment past the grace period.
 * `outcome` is what was written to the activity log (`refused` when the
 * pre-charge check refused it).
 */
export class FraudAssessedEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext | undefined,
        public subject: FraudEventSubject,
        public assessment: FraudAssessment,
        public stage: 'pre-charge' | 'placed' | 'unpaid',
        public outcome: string,
    ) {
        super();
    }
}

/** A block-level order was refused before the charge (hold or enforce mode),
 *  or an address in its failed-payment cooldown tried to pay. */
export class FraudPaymentRefusedEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext | undefined,
        public subject: FraudEventSubject,
        public assessment: FraudAssessment | null,
        public reason: 'block-level' | 'failed-payment-cooldown',
    ) {
        super();
    }
}

/** A review case was opened (enforce mode, premium). */
export class FraudCaseOpenedEvent extends VendureEvent {
    constructor(
        public caseId: number,
        public subject: FraudEventSubject,
        public assessment: FraudAssessment,
    ) {
        super();
    }
}

/** A review case was approved or rejected (by an admin or the auto-release). */
export class FraudCaseResolvedEvent extends VendureEvent {
    constructor(
        public caseId: number,
        public decision: 'approved' | 'rejected',
        public orderId: number | null,
        public orderCode: string | null,
        public details: { captured?: number[]; cancelled?: boolean; refunds?: Array<{ paymentId: number; amount: number }>; warnings?: string[]; auto?: boolean },
    ) {
        super();
    }
}
