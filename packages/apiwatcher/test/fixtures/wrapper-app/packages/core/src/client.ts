import Stripe from 'stripe';

import { STRIPE_API_VERSION } from '@/config/constants';

// Env-guarded construction: the client is inside a conditional, not assigned
// directly to the declaration.
export const stripeClient = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  : null;

// Lazy factory, the recommended pattern when env access must be deferred.
export const getStripeClient = () => {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
};
