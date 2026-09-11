// Imported by workspace package name, then aliased to a local variable that
// says nothing about Stripe.
import { stripeClient } from '@wrapper/core/src/client';

export async function listProducts() {
  const client = stripeClient;
  const products = await client.products.list({ limit: 5 });
  return products.data.map((p) => p.default_price);
}
