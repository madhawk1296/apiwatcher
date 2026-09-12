import { stripe } from '../lib/index.js';

export async function createCheckout(priceId: string) {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: 'https://example.com/ok',
    subscription_data: {
      pending_invoice_item_interval: { interval: 'month' },
    },
  });
  return { url: session.url, total: session.amount_total };
}

export async function listRefunds() {
  const refunds = await stripe.refunds.list({ limit: 10 });
  return refunds.data.map((r) => r.destination_details);
}

export async function updateConfig(configId: string) {
  return stripe.terminal.configurations.update(configId, {
    tipping: { bgn: { fixed_amounts: [100] } },
  });
}
