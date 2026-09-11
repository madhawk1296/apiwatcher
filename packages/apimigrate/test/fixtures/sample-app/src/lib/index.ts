// A barrel re-export, so importers are one hop further from `new Stripe(...)`.
export { stripe, chargeCustomer } from './payments.js';
