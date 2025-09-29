import { z } from "zod";
import path from "node:path";
import dotenv from "dotenv";
import { existsSync } from "node:fs";

const loadedEnvFiles = new Set<string>();

function loadEnvFile(envPath: string): void {
  if (!envPath || loadedEnvFiles.has(envPath)) {
    return;
  }
  if (!existsSync(envPath)) {
    return;
  }
  dotenv.config({ path: envPath, override: false });
  loadedEnvFiles.add(envPath);
}

export const modelConfigSchema = z.object({
  model: z.string().default("gpt-5-mini"),
  temperature: z.number().min(0).max(1).default(0.2),
  maxOutputTokens: z.number().int().positive().default(2048)
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const runtimeConfigSchema = z.object({
  workspaceRoot: z.string().default(process.cwd()),
  dryRun: z.boolean().default(false),
  verbose: z.boolean().default(false)
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export const settingsSchema = z.object({
  openAiApiKey: z.string().min(1, "OPENAI_API_KEY is required").or(z.undefined()),
  openAiBaseUrl: z.string().optional(),
  defaultModel: modelConfigSchema.default(modelConfigSchema.parse({})),
  runtime: runtimeConfigSchema.default(runtimeConfigSchema.parse({}))
});

export type Settings = z.infer<typeof settingsSchema>;

export interface SettingsOverrides {
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  defaultModel?: Partial<ModelConfig>;
  runtime?: Partial<RuntimeConfig>;
}

export function loadSettings(overrides: SettingsOverrides = {}): Settings {
  const cwdEnv = path.resolve(process.cwd(), ".env");
  loadEnvFile(cwdEnv);

  const envWorkspace = process.env.MYAIDE_WORKSPACE;
  const runtimeInput = {
    workspaceRoot: overrides.runtime?.workspaceRoot ?? envWorkspace ?? process.cwd(),
    dryRun: overrides.runtime?.dryRun ?? false,
    verbose: overrides.runtime?.verbose ?? false
  } satisfies RuntimeConfig;

  const workspaceEnvPath = path.join(path.resolve(runtimeInput.workspaceRoot), ".env");
  loadEnvFile(workspaceEnvPath);

  const payload = {
    openAiApiKey: overrides.openAiApiKey ?? process.env.OPENAI_API_KEY,
    openAiBaseUrl: overrides.openAiBaseUrl ?? process.env.OPENAI_BASE_URL,
    defaultModel: {
      model: overrides.defaultModel?.model ?? "gpt-4.1-mini",
      temperature: overrides.defaultModel?.temperature ?? 0.2,
      maxOutputTokens: overrides.defaultModel?.maxOutputTokens ?? 2048
    },
    runtime: {
      workspaceRoot: path.resolve(runtimeInput.workspaceRoot),
      dryRun: runtimeInput.dryRun,
      verbose: runtimeInput.verbose
    }
  } satisfies Settings;

  const parsed = settingsSchema.safeParse(payload);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Failed to load settings: ${message}`);
  }

  return parsed.data;
}
