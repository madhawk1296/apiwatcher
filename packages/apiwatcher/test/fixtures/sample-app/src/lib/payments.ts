// A wrapper module: call sites downstream never mention Stripe by name.
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2025-09-30.clover',
});

export async function chargeCustomer(customerId: string, amount: number) {
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    customer: customerId,
    automatic_payment_methods: { enabled: true },
  });
  return intent.amount_received;
}
