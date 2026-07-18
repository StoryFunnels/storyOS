import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { env } from '../config/env';

/**
 * Thin wrapper around the Stripe SDK. Billing is OPTIONAL: with no
 * STRIPE_SECRET_KEY (every self-host, and any dev box that hasn't wired Stripe)
 * the client is never constructed and `enabled` is false — callers degrade to
 * "everything is Free" rather than crash. We never pin an apiVersion so the SDK
 * tracks the account default and TS isn't coupled to a dated literal.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;

  constructor() {
    const key = env().STRIPE_SECRET_KEY?.trim();
    this.stripe = key ? new Stripe(key) : null;
    if (!this.stripe) {
      this.logger.log('STRIPE_SECRET_KEY unset — billing disabled (all workspaces Free).');
    } else if (key?.startsWith('sk_live_') && env().NODE_ENV !== 'production') {
      // A live key outside production is almost always a mistake and risks real
      // charges during development — refuse it loudly rather than proceed.
      throw new Error('Refusing to use a live Stripe key (sk_live_) outside production.');
    }
  }

  get enabled(): boolean {
    return this.stripe !== null;
  }

  /** The client, or a 503 — use in request paths that require billing to be live. */
  get client(): Stripe {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Billing is not configured on this instance.');
    }
    return this.stripe;
  }

  /**
   * Verify a webhook payload against the signing secret and parse it. Throws if
   * the signature or secret is wrong — the caller turns that into a 400 so Stripe
   * retries, and an unverified body is never read as an event.
   */
  constructEvent(payload: Buffer, signature: string): Stripe.Event {
    const secret = env().STRIPE_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new ServiceUnavailableException('STRIPE_WEBHOOK_SECRET is not configured.');
    }
    return this.client.webhooks.constructEvent(payload, signature, secret);
  }
}
