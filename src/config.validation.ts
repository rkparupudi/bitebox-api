/**
 * Fail fast at startup if required configuration is missing or obviously unsafe,
 * instead of failing on the first request that needs it.
 */
export function validateConfig(env: Record<string, unknown>) {
  const errors: string[] = [];
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET']) {
    if (!env[key]) errors.push(`${key} is required`);
  }
  const provider = (env.PAYMENTS_PROVIDER as string) ?? 'stripe';
  if (!['stripe', 'fake'].includes(provider)) errors.push('PAYMENTS_PROVIDER must be stripe or fake');
  if (env.NODE_ENV === 'production') {
    if (provider === 'fake') errors.push('PAYMENTS_PROVIDER=fake is not allowed in production');
    if (String(env.JWT_SECRET ?? '').length < 32) errors.push('JWT_SECRET must be at least 32 characters in production');
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) errors.push('Stripe keys are required in production');
  }
  if (errors.length) throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);
  return env;
}
