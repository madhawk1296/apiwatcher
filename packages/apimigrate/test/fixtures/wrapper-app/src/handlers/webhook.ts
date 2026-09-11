import type Stripe from 'stripe';

import { getStripeClient } from '@wrapper/core/src/client';

// The client arrives as a typed parameter: nothing in the call site names Stripe.
export async function refundCharge(stripe: Stripe, chargeId: string) {
  return stripe.refunds.create({ charge: chargeId });
}

export async function cancelSubscription(id: string) {
  const sdk = getStripeClient();
  return sdk.subscriptions.cancel(id);
}
