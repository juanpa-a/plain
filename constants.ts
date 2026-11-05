export const CONFIG_DIR: string = `${Bun.env.HOME}/.config/plain`;
export const CONFIG_PATH: string = `${CONFIG_DIR}/config.json`;
export const PROMPTS_OVERRIDES_DIR: string = `${CONFIG_DIR}/prompts`;
export const RUNS_DIR: string = `${CONFIG_DIR}/runs`;

export const DEFAULT_SPEC_PATH: string = "spec.yaml";
export const DEFAULT_MODEL: string = "kimi-k3";

export const MAX_ATTEMPTS: number = 3;
export const MAX_RETRIES: number = 5;
export const RETRY_DELAY_MS: number = 2000;
