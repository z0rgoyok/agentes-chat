/**
 * The scope of the sandbox tools: on by default, and not covered by "all tools" (ADR 0021).
 * Apart from the sandbox module so a module in its import cycle can read it while loading.
 */
export const SANDBOX_SCOPE = "sandbox:run";
