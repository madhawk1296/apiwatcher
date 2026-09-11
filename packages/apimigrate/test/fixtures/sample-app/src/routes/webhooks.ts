// Raw REST call with no SDK involved, plus webhook event handling.
const SECRET = process.env.STRIPE_SECRET_KEY;

export async function cancelIntentRaw(id: string) {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${id}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  });
  return res.json();
}

export function handleEvent(event: { type: string; data: { object: unknown } }) {
  switch (event.type) {
    case 'invoice.payment_failed':
      return 'retry';
    case 'customer.subscription.deleted':
      return 'revoke';
    default:
      return 'ignore';
  }
}
