import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type AgentProvider = "anthropic" | "openai";

export interface CoauthorConfig {
  readonly provider: AgentProvider;
  readonly model: string;
  readonly apiKey: string;
  readonly temperature: number;
  readonly maxSteps: number;
}

export interface CoauthorConfigError {
  readonly error: string;
}

export type CoauthorConfigResult = CoauthorConfig | CoauthorConfigError;

let dotenvLoaded = false;

function findEnvFile(start: string): string | undefined {
  let dir = start;
  while (true) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function ensureDotenv(): void {
  if (dotenvLoaded) return;
  const found = findEnvFile(process.cwd());
  if (found) loadDotenv({ path: found });
  else loadDotenv();
  dotenvLoaded = true;
}

function parseFloatOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadCoauthorConfig(env: NodeJS.ProcessEnv = process.env): CoauthorConfigResult {
  ensureDotenv();
  const provider = (env.QUALMS_AGENT_PROVIDER ?? "anthropic").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") {
    return {
      error: `unsupported QUALMS_AGENT_PROVIDER '${provider}' (expected 'anthropic' or 'openai')`,
    };
  }
  const model = env.QUALMS_AGENT_MODEL ?? defaultModel(provider);
  const apiKey =
    provider === "anthropic" ? env.ANTHROPIC_API_KEY ?? "" : env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    const varName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return { error: `${varName} is not set; copy .env.template to .env and fill it in` };
  }
  return {
    provider,
    model,
    apiKey,
    temperature: parseFloatOrDefault(env.QUALMS_AGENT_TEMPERATURE, 0.2),
    maxSteps: parseIntOrDefault(env.QUALMS_AGENT_MAX_STEPS, 16),
  };
}

export function isCoauthorConfigError(value: CoauthorConfigResult): value is CoauthorConfigError {
  return "error" in value;
}

function defaultModel(provider: AgentProvider): string {
  return provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4.1-mini";
}
