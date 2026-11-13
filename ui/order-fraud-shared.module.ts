import { NgModule } from '@angular/core';
import { SharedModule, registerCustomDetailComponent, registerDataTableComponent } from '@vendure/admin-ui/core';
import { OrderFraudPanelComponent } from './components/order-fraud-panel.component';
import { OrderRiskColumnComponent } from './components/order-risk-column.component';

/**
 * Embeds the fraud-score panel on the admin order-detail page.
 * The panel itself only renders once the order is paid. Also adds an
 * optional "Fraud risk" column to the orders list (column picker).
 */
@NgModule({
    imports: [SharedModule],
    providers: [
        registerCustomDetailComponent({
            locationId: 'order-detail',
            component: OrderFraudPanelComponent,
        }),
        registerDataTableComponent({
            tableId: 'order-list',
            columnId: 'hulo-fraud-risk',
            component: OrderRiskColumnComponent,
        }),
    ],
})
export class OrderFraudSharedModule {}
