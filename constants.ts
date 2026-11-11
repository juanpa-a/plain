export const CONFIG_DIR: string = `${Bun.env.HOME}/.config/plain`;
export const CONFIG_PATH: string = `${CONFIG_DIR}/config.json`;
export const PROMPTS_OVERRIDES_DIR: string = `${CONFIG_DIR}/prompts`;
export const RUNS_DIR: string = `${CONFIG_DIR}/runs`;

export const EXIT_FAIL: number = 1;
export const EXIT_INVALID_SPEC: number = 2;
export const EXIT_BLOCKED: number = 3;

export const DEFAULT_SPEC_PATH: string = "spec.yaml";
export const DEFAULT_MODEL: string = "kimi-k3";

export const MAX_ATTEMPTS: number = 3;
export const DEFAULT_CONCURRENCY: number = 4;
export const MAX_RETRIES: number = 5;
export const RETRY_DELAY_MS: number = 2000;
// waiting for a free cloud agent slot of the plan: up to 15 minutes
export const LIMIT_RETRY_DELAY_MS: number = 30_000;
export const LIMIT_MAX_WAITS: number = 30;
