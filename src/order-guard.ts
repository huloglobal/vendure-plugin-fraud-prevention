import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, Logger, OrderPlacedEvent, ProcessContext } from '@vendure/core';
import { FraudPreventionService, AssessInput } from './fraud-prevention.service';
import { normaliseIp } from './net-util';
import { FraudAssessedEvent } from './events';
import { flaggedAlert, heldAlert, shadowAlert } from './alerts';

const loggerCtx = 'FraudPrevention';

/**
 * The enforcement point the old implementation never had: every placed
 * order is assessed server-side. What happens then depends on the
 * channel's mode:
 *
 *   off      -> scored and logged as 'shadow', nothing else
 *   monitor  -> assessment logged; flagged orders marked 'flag' but never held
 *   hold     -> as monitor once placed (block-level orders were already
 *               refused before the charge by the pre-charge check)
 *   enforce  -> score >= reviewThreshold opens a pending review case
 *               (hosts gate fulfilment on pendingOrderIds()); score >=
 *               blockThreshold additionally tells the customer the order
 *               is under verification and alerts the admin
 *
 * Runs on the server process only — the worker would double-assess.
 */
@Injectable()
export class FraudOrderGuard implements OnApplicationBootstrap {
    constructor(
        private eventBus: EventBus,
        private service: FraudPreventionService,
        private processContext: ProcessContext,
    ) {}

    onApplicationBootstrap() {
        if (!this.processContext.isServer) return;
        // At most a few assessments in flight: a burst of orders must not become a burst of
        // external lookups and database round trips all at once.
        const MAX_CONCURRENT = 6;
        let running = 0;
        const queue: Array<() => void> = [];
        const run = async (event: OrderPlacedEvent) => {
            if (running >= MAX_CONCURRENT) await new Promise<void>(resolve => queue.push(resolve));
            running++;
            try {
                await this.handleOrderPlaced(event);
            } catch (e: any) {
                Logger.error(`Order assessment failed for ${event.order?.code}: ${e.message}`, loggerCtx);
            } finally {
                running--;
                queue.shift()?.();
            }
        };
        this.eventBus.ofType(OrderPlacedEvent).subscribe(event => { void run(event); });
    }

    private async handleOrderPlaced(event: OrderPlacedEvent) {
        const order = event.order;
        const channelId = Number(event.ctx.channelId || 1);
        const email = order.customer?.emailAddress || '';

        const input: AssessInput = {
            channelId,
            ip: normaliseIp((order.customFields as any)?.ip) || undefined,
            email,
            orderValuePence: order.subTotalWithTax || 0,
            currencyCode: (order as any).currencyCode || undefined,
            countryCode: order.billingAddress?.countryCode || order.shippingAddress?.countryCode || undefined,
            shippingCountryCode: order.shippingAddress?.countryCode || undefined,
            billingPostalCode: order.billingAddress?.postalCode || undefined,
            shippingPostalCode: order.shippingAddress?.postalCode || undefined,
            // Card AVS verdict — host resolver, payment metadata, or Stripe.
            avs: await this.service.resolveAvsForOrder(event.ctx, order),
            orderId: Number(order.id),
            orderCode: order.code,
            // customer history is computed inside the service by canonical
            // email, so plus-tag variants share one track record
        };

        const assessment = await this.service.assess(input);
        // Hold mode acts before the charge only: a placed order is paid, so a risky one is flagged.
        if (assessment.action === 'hold') assessment.action = 'flag';

        // In enforce mode the review case is written BEFORE the assessment log: the host
        // fulfilment gate treats "assessed and no case" as releasable, so the case must exist
        // first or a fulfilment run in that gap could release keys for an order about to be held.
        const held = assessment.protectionActive !== false && (assessment.action === 'review' || assessment.action === 'block');
        const caseId = held ? await this.service.createCase(input, assessment) : 0;

        // Always log — shadow assessments included, so the score history
        // has no blind spots even while protection is switched off.
        await this.service.logAssessment(input, assessment);
        this.service.publish(new FraudAssessedEvent(event.ctx, this.service.subjectOf(input), assessment, 'placed', assessment.action));

        if (assessment.protectionActive === false) {
            if (assessment.action === 'shadow') {
                Logger.warn(
                    `Order ${order.code} scored ${assessment.score}/100 (${assessment.level}) but fraud protection is OFF — no action taken. ` +
                    `Signals: ${assessment.signals.map(s => s.label).join(', ')}`,
                    loggerCtx,
                );
                await this.service.notifyOps({
                    event: 'shadow.risky',
                    text: `⚠️ Fraud protection is OFF, but order ${order.code} scored ${assessment.score}/100 (${assessment.level}). ` +
                        `No action was taken. Signals: ${assessment.signals.map(s => s.label).join(', ')}. ` +
                        `Enable protection in the Fraud Prevention settings to act on orders like this.`,
                    orderCode: order.code,
                    email,
                    score: assessment.score,
                    level: assessment.level,
                    signals: assessment.signals.map(s => ({ key: s.key, label: s.label, points: s.points })),
                });
                const notif = await this.service.getNotificationConfig();
                if (notif.notifyOnHighRisk) {
                    void this.service.sendAdminAlert(
                        `Protection off: order ${order.code} scored ${assessment.score}/100`,
                        shadowAlert({ orderCode: order.code, orderId: order.id, email, score: assessment.score, level: assessment.level, signals: assessment.signals }),
                    );
                }
            }
            return;
        }

        if (assessment.action === 'allow' || assessment.action === 'flag') {
            if (assessment.action === 'flag') {
                Logger.warn(
                    `Order ${order.code} flagged (score ${assessment.score}, ${assessment.mode} mode): ` +
                    assessment.signals.map(s => s.label).join(', '),
                    loggerCtx,
                );
                // Monitor-mode alerts (premium; sendAdminAlert / notifyOps are silent on the free tier).
                const notif = await this.service.getNotificationConfig();
                await this.service.notifyOps({
                    event: 'order.flagged',
                    text: `⚠️ Order ${order.code} flagged — score ${assessment.score}/100 (${assessment.level}), not held. ` +
                        assessment.signals.map(s => s.label).join(', '),
                    orderCode: order.code, email, score: assessment.score, level: assessment.level,
                    signals: assessment.signals.map(s => ({ key: s.key, label: s.label, points: s.points })),
                });
                if (notif.notifyOnHighRisk) {
                    void this.service.sendAdminAlert(
                        `Order ${order.code} flagged (score ${assessment.score})`,
                        flaggedAlert({
                            orderCode: order.code, orderId: order.id, email, score: assessment.score, level: assessment.level,
                            signals: assessment.signals, mode: assessment.mode, baseUrl: this.service.getOptions().publicBaseUrl,
                        }),
                    );
                }
            }
            return;
        }

        // enforce mode, review or block (case already created above)
        Logger.warn(
            `Order ${order.code} held for review (case #${caseId}, score ${assessment.score}, action ${assessment.action})`,
            loggerCtx,
        );

        await this.service.notifyOps({
            event: 'case.held',
            text: `🚨 Order ${order.code} held for review — score ${assessment.score}/100 (${assessment.level}). ` +
                assessment.signals.map(s => s.label).join(', '),
            orderCode: order.code,
            email,
            score: assessment.score,
            level: assessment.level,
            signals: assessment.signals.map(s => ({ key: s.key, label: s.label, points: s.points })),
        });

        const notif = await this.service.getNotificationConfig();
        const wantAdminMail = assessment.action === 'block' ? notif.notifyOnBlocked : notif.notifyOnHighRisk;
        if (wantAdminMail) {
            void this.service.sendAdminAlert(
                `Order ${order.code} held for review (score ${assessment.score})`,
                heldAlert({
                    orderCode: order.code, orderId: order.id, email, score: assessment.score, level: assessment.level,
                    signals: assessment.signals, block: assessment.action === 'block', baseUrl: this.service.getOptions().publicBaseUrl,
                }),
            );
        }

        // Customer-facing held notice — per-channel policy + template.
        const cfg = await this.service.getConfig(channelId);
        const policy = (cfg as any).notifyCustomerOnHold || 'block';
        const shouldTell = policy === 'always' || (policy === 'block' && assessment.action === 'block');
        if (shouldTell && email) {
            void this.service.sendCustomerTemplate(channelId, 'held', email, {
                orderCode: order.code,
                firstName: (order.customer as any)?.firstName || undefined,
            });
        }
    }
}
