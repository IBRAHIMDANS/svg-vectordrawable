import fc from 'fast-check';

/**
 * Shared fast-check settings for the `*.property.test.ts` suites.
 *
 * The seed is fixed by default so CI never turns red on a draw unrelated to the change under review.
 * `FC_SEED=<n>` replays a reported failure; `FC_SEED=random` explores new draws locally.
 * `FC_RUNS=<n>` raises the number of draws per property (default 300).
 */
const DEFAULT_SEED = 20261113;

const seedEnv = process.env.FC_SEED;
const seed = seedEnv === 'random' ? undefined : seedEnv ? Number(seedEnv) : DEFAULT_SEED;
const numRuns = process.env.FC_RUNS ? Number(process.env.FC_RUNS) : 300;

/** Parameters passed to every `fc.assert` of the property suites. */
export const propertyParams: fc.Parameters<unknown> = seed === undefined ? { numRuns } : { numRuns, seed };

/** Test timeout that grows with `FC_RUNS`: 10 s by default, 1 ms per draw beyond. */
export const propertyTimeout = Math.max(10_000, numRuns);
