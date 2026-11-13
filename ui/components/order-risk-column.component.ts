import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Injectable, Input, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CustomColumnComponent, SharedModule } from '@vendure/admin-ui/core';

type Risk = { score: number; level: string; action: string; caseStatus: string | null };

/**
 * Batches the rows of one orders-list page into a single
 * GET /fraud-prevention/order-risk?ids=… (at most 100 ids per call).
 */
@Injectable({ providedIn: 'root' })
export class OrderRiskBatcher {
    private pending = new Map<string, Array<(r: Risk | null) => void>>();
    private timer: any = null;

    constructor(private http: HttpClient) {}

    get(orderId: string): Promise<Risk | null> {
        return new Promise(resolve => {
            const list = this.pending.get(orderId) || [];
            list.push(resolve);
            this.pending.set(orderId, list);
            if (!this.timer) this.timer = setTimeout(() => this.flush(), 30);
        });
    }

    private flush() {
        this.timer = null;
        const batch = new Map(this.pending);
        this.pending.clear();
        const ids = Array.from(batch.keys());
        for (let i = 0; i < ids.length; i += 100) {
            const chunk = ids.slice(i, i + 100);
            this.http.get<Record<string, Risk>>(`/fraud-prevention/order-risk?ids=${chunk.map(encodeURIComponent).join(',')}`).subscribe({
                next: r => chunk.forEach(id => (batch.get(id) || []).forEach(fn => fn(r?.[id] || null))),
                error: () => chunk.forEach(id => (batch.get(id) || []).forEach(fn => fn(null))),
            });
        }
    }
}

/** "Fraud risk" column on the admin orders list (choose it in the column picker). */
@Component({
    selector: 'hulo-order-risk-column',
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
    template: `
        <span *ngIf="risk" class="risk-pill" [class.lvl-low]="risk.level === 'low' || risk.level === 'medium'"
              [class.lvl-review]="risk.level === 'review'" [class.lvl-blocked]="risk.level === 'blocked'"
              [title]="title()">{{ risk.score }}<small>/100</small><span class="act" *ngIf="label()"> · {{ label() }}</span></span>
        <span *ngIf="loaded && !risk" class="none">–</span>
    `,
    styles: [`
        .risk-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; border: 1px solid transparent; white-space: nowrap; }
        .risk-pill small { font-weight: 600; opacity: .7; }
        .act { font-weight: 600; }
        .lvl-low { background: #ecfdf5; border-color: #34d399; color: #065f46; }
        .lvl-review { background: #fffbeb; border-color: #fbbf24; color: #92400e; }
        .lvl-blocked { background: #fef2f2; border-color: #f87171; color: #991b1b; }
        .none { opacity: .5; }
    `],
})
export class OrderRiskColumnComponent implements CustomColumnComponent, OnInit {
    @Input() rowItem: any;
    risk: Risk | null = null;
    loaded = false;

    constructor(private batcher: OrderRiskBatcher, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        const raw = String(this.rowItem?.id ?? '');
        if (!raw) { this.loaded = true; return; }
        void this.batcher.get(raw.replace(/^T_/, '')).then(r => { this.risk = r; this.loaded = true; this.cdr.markForCheck(); });
    }

    label(): string {
        const r = this.risk;
        if (!r) return '';
        if (r.caseStatus === 'pending') return 'in review';
        if (r.caseStatus === 'rejected') return 'rejected';
        if (r.action === 'refused') return 'refused';
        if (r.action === 'unpaid') return 'unpaid';
        if (r.action === 'flag') return 'flagged';
        return '';
    }

    title(): string {
        const r = this.risk;
        return r ? `Fraud score ${r.score}/100 (${r.level}), action ${r.action}${r.caseStatus ? `, case ${r.caseStatus}` : ''}` : '';
    }
}
