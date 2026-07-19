/**
 * FOAI governance layer — the structural delta over MoonshotAI/kimi-code.
 *
 * See FORK-CHANGES.md at the repository root for the what-and-why. This barrel
 * re-exports the governance surface consumed by the upstream wiring points and
 * by the FOAI test suite.
 */

export * from './governance';
export * from './decision-id';
export * from './receipts';
export * from './governed-provider';
export * from './governed-write';
export * from './runtime';
