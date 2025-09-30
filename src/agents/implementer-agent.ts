import { Agent, AgentStatus, type AgentResult, type TokenUsage } from "./agent-base";
import { LLMClient } from "../llm/openai-client";
import type { ChatMessage } from "../llm/openai-client";
import type { FileMutation, FileSystemTool } from "../tools/filesystem";
import { buildWorkspaceSummary } from "../context/workspace-summary";
import { applyPatch, parsePatch } from "diff";
import { jsonrepair } from "jsonrepair";

interface AnchorSpec {
  exact?: string;
  regex?: string;
  description?: string;
}

interface ImplementationAction {
  type: "write_file" | "modify_file" | "delete_path";
  path: string;
  content?: string;
  patch?: string;
  patches?: string[];
  mode?: "replace" | "insert_after" | "insert_before";
  anchor?: AnchorSpec;
  replacement?: string;
  snippet?: string;
  ensure?: string;
}

interface ImplementationPayload {
  actions: ImplementationAction[];
  notes?: string;
}

const PATCH_HEADER_PREFIXES = [
  "diff --git",
  "index ",
  "---",
  "+++",
  "Binary files",
  "new file mode",
  "deleted file mode",
  "rename from",
  "rename to",
  "old mode",
  "new mode"
];

const JSON_SCHEMA_HELP = `Return a JSON object with the following structure (no additional keys):
{
  "actions": [
    {
      "type": "write_file" | "modify_file" | "delete_path",
      "path": "relative/path",
      "content"?: "full file contents for write_file",
      "patch"?: "unified diff for modify_file",
      "mode"?: "replace" | "insert_after" | "insert_before",
      "anchor"?: { "exact"?: "string", "regex"?: "pattern" },
      "snippet"?: "text for inserts",
      "replacement"?: "text for replace",
      "ensure"?: "post-condition substring"
    }
  ],
  "notes": "short summary string"
}`;

const RETRY_SYSTEM_PROMPT = `You convert invalid JSON into valid JSON. Output ONLY a JSON object that matches the schema below. Do not include commentary, markdown fences, or explanations. ${JSON_SCHEMA_HELP}`;

const SYSTEM_PROMPT = `You are the implementation agent in a multi-agent coding assistant.
Review the workspace summary carefully and reuse the existing tech stack.
Only introduce new languages or frameworks when explicitly requested.

CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. NEVER duplicate existing code! Check the file context for existing implementations
2. If a feature already exists, MODIFY it instead of creating duplicates
3. ALWAYS prefer anchor-based edits over unified diffs for modify_file operations
4. Use "mode" with "anchor" for precise modifications:
   - "replace": Replace anchor.exact text with replacement
   - "insert_after": Insert snippet after anchor.exact
   - "insert_before": Insert snippet before anchor.exact
5. Copy anchor.exact strings VERBATIM from the file context provided
6. Only use unified diff patches as a last resort when anchor-based edits are impossible
7. For new files, use write_file with complete content
8. Return ONLY valid JSON with no markdown fences, no explanations, no commentary

ANTI-DUPLICATION RULES:
- Before adding a function, check if it already exists in the file
- Before adding a class, check if it already exists in the file
- Before adding HTML elements, check if similar elements exist
- If something exists, enhance or modify it rather than duplicating

Response format (JSON only):
{
  "actions": [
    {"type": "write_file", "path": "relative/path", "content": "full file contents"},
    {"type": "modify_file", "path": "relative/path", "mode": "replace|insert_after|insert_before", "anchor": {"exact": "verbatim text from file"}, "replacement": "new text" OR "snippet": "text to insert"},
    {"type": "delete_path", "path": "relative/path"}
  ],
  "notes": "summary"
}

Remember: anchor.exact must be copied EXACTLY from the file context. Do not paraphrase or modify it.`;

const ANCHOR_ACTION_EXAMPLE = `Example response format:
{
  "actions": [
    {
      "type": "modify_file",
      "path": "index.html",
      "mode": "insert_after",
      "anchor": { "exact": "<ul class=\"nav\">" },
      "snippet": "  <li class=\"nav-item\">New link</li>"
    },
    {
      "type": "modify_file",
      "path": "index.html",
      "mode": "replace",
      "anchor": { "exact": "<div id=\"feature\"></div>" },
      "replacement": "<div id=\"feature\">...</div>",
      "ensure": "<div id=\"feature\">"
    }
  ],
  "notes": "short summary"
}`;

export class ImplementerAgent extends Agent {
  readonly name = "implementer";
  readonly description = "Applies code changes suggested by the planner.";
  private debugLog: string[] = [];

  private log(message: string): void {
    this.debugLog.push(message);
  }

  async run(): Promise<AgentResult> {
    this.debugLog = [];
    this.log("Implementer starting.");

    const fsTool = this.context.filesystem;
    if (!fsTool) {
      return { agent: this.name, status: AgentStatus.Failure, summary: "Filesystem tool unavailable." };
    }
    if (!this.context.plan.length) {
      return { agent: this.name, status: AgentStatus.Failure, summary: "No plan available to implement." };
    }
    if (!this.context.settings.openAiApiKey) {
      return { agent: this.name, status: AgentStatus.Failure, summary: "Missing OPENAI_API_KEY; implementation skipped." };
    }

    try {
      const client = new LLMClient(this.context.settings);
      const prompt = await this.buildPrompt();
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ];
      this.log("Requesting primary implementation completion.");
      const completion = await client.complete(messages);
      this.context.usage.prompt += completion.usagePromptTokens ?? 0;
      this.context.usage.completion += completion.usageCompletionTokens ?? 0;
      this.log(
        `Primary completion received (prompt tokens: ${completion.usagePromptTokens ?? 0}, completion tokens: ${completion.usageCompletionTokens ?? 0}).`
      );

      let { payload, error: parseError } = this.parsePayloadSafe(completion.content);

      if (!payload) {
        const baseError = parseError ?? new Error("Unknown JSON parsing issue");
        this.log(`Primary JSON parse failed: ${baseError.message}. Attempting repairs (max 2 retries).`);

        // Try up to 2 repair attempts
        let retryCount = 0;
        let lastRaw = completion.content;

        while (!payload && retryCount < 2) {
          retryCount++;
          this.log(`Repair attempt ${retryCount}/2...`);
          const retry = await this.retryInvalidJson(client, lastRaw, parseError ?? baseError, retryCount);
          if (retry.usage) {
            this.context.usage.prompt += retry.usage.prompt ?? 0;
            this.context.usage.completion += retry.usage.completion ?? 0;
            this.log(
              `Repair completion ${retryCount} received (prompt tokens: ${retry.usage.prompt ?? 0}, completion tokens: ${retry.usage.completion ?? 0}).`
            );
          }
          payload = retry.payload;
          parseError = retry.payload ? undefined : retry.error ?? baseError;
          lastRaw = retry.raw ?? lastRaw;

          if (payload) {
            this.log(`Repair attempt ${retryCount} succeeded.`);
            break;
          } else {
            this.log(`Repair attempt ${retryCount} failed: ${parseError?.message}`);
          }
        }

        if (!payload) {
          const snippet = truncateForError(lastRaw, 1200);
          throw new Error(
            `Failed to parse implementer response as JSON after ${retryCount} repair attempt(s): ${parseError?.message ?? "unknown"}\n\nLast response snippet:\n${snippet}\n\nSuggestion: Request the implementation in smaller steps or fewer files at once.`
          );
        }
      } else {
        this.log("Primary completion parsed successfully.");
      }

      if (!payload) {
        const snippet = truncateForError(completion.content);
        throw new Error(`Implementer did not return actionable JSON. Snippet:\n${snippet}`);
      }

      const mutations = await this.applyActions(payload.actions, fsTool);
      this.context.artifacts["implementation"] = payload;

      // Count how many plan steps were addressed by counting distinct file modifications
      const affectedFiles = new Set(mutations.map((m) => m.path));
      const completedSteps = Math.min(affectedFiles.size, this.context.plan.length);

      return {
        agent: this.name,
        status: AgentStatus.Success,
        summary: payload.notes ?? "Applied implementation actions.",
        mutations,
        details: this.debugLog.join("\n"),
        completedPlanSteps: completedSteps
      };
    } catch (error) {
      this.log(`Failure: ${(error as Error).message}`);
      return {
        agent: this.name,
        status: AgentStatus.Failure,
        summary: (error as Error).message,
        details: this.debugLog.join("\n")
      };
    }
  }

  private async buildPrompt(): Promise<string> {
    const planText = this.context.plan.map((step, idx) => `${idx + 1}. ${step}`).join("\n");
    const history = this.context.history
      .map((result) => `${result.agent}: ${result.status} - ${result.summary}`)
      .join("\n") || "None";
    const memory = this.context.memory
      .slice(-6)
      .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
      .join("\n");
    const workspaceSummary = await this.getWorkspaceSummary();
    const existingContext = await this.collectExistingContext();
    const myAIDEContent = this.context.artifacts["myAIDEContent"] as string | undefined;

    const sections = [
      `User request:\n${this.context.request}`,
      `Plan:\n${planText}`,
      myAIDEContent ? `Project Architecture (from myAIDE.md):\n${myAIDEContent}` : "",
      workspaceSummary ? `Workspace summary:\n${workspaceSummary}` : "",
      memory ? `Recent conversation:\n${memory}` : "",
      `Prior results:\n${history}`,
      existingContext,
      "Guidance:",
      "- Use modify_file with unified diff for existing files to avoid wiping unrelated code.",
      "- Only use write_file for brand new files (include full contents).",
      "- Delete_path only when removal is part of the plan.",
      "- Unified diff example: @@\n- old line\n+ new line",
      "- Prefer anchors (anchor.exact) copied verbatim from the context when inserting.",
      ANCHOR_ACTION_EXAMPLE,
      "Return JSON as per schema."
    ];

    return sections.filter(Boolean).join("\n\n");
  }

  private parsePayload(raw: string): ImplementationPayload {
    this.log("Parsing JSON payload.");
    const sanitized = this.sanitizeJson(raw);
    const parsed = this.parseWithRepair(sanitized, raw) as ImplementationPayload;
    if (!Array.isArray(parsed.actions)) {
      throw new Error("Missing actions array in payload");
    }
    parsed.actions = parsed.actions.flatMap((action) => this.normalizeAction(action));
    return parsed;
  }

  private sanitizeJson(raw: string): string {
    let trimmed = normalizeJsonText(raw, true);
    if (trimmed.startsWith("```")) {
      const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
      if (fenceMatch) {
        trimmed = fenceMatch[1];
      }
    }
    if (!trimmed.startsWith("{")) {
      const first = trimmed.indexOf("{");
      const last = trimmed.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last >= first) {
        trimmed = trimmed.slice(first, last + 1);
      }
    }
    return normalizeJsonText(trimmed, true);
  }

  private parsePayloadSafe(raw: string): { payload?: ImplementationPayload; error?: Error } {
    try {
      const payload = this.parsePayload(raw);
      return { payload };
    } catch (error) {
      this.log(`JSON parse attempt failed: ${(error as Error).message}`);
      return { error: error as Error };
    }
  }

  private async collectExistingContext(): Promise<string> {
    const fsTool = this.context.filesystem;
    if (!fsTool) {
      return "";
    }
    const decision = this.context.artifacts["decision"] as
      | { operations?: Array<{ action?: string; path?: string }> }
      | undefined;

    const candidatePaths = new Set<string>();
    decision?.operations?.forEach((op) => {
      if (op?.path && (op.action === "modify" || op.action === "delete")) {
        candidatePaths.add(op.path);
      }
    });

    if (!candidatePaths.size) {
      return "";
    }

    const snippets: string[] = [];
    const codeScan = this.context.artifacts["codeScan"] as
      | { items?: Array<{ path: string; snippet: string }> }
      | undefined;
    if (codeScan?.items) {
      for (const item of codeScan.items) {
        if (!candidatePaths.has(item.path)) {
          candidatePaths.add(item.path);
        }
      }
    }
    let remainingBudget = 8000; // Increased from 4000 to provide more context
    for (const path of candidatePaths) {
      if (remainingBudget <= 0) {
        break;
      }
      try {
        const content = await fsTool.read(path);
        const lines = content.replace(/\r\n/g, "\n").split("\n");
        // Provide full file for small files, otherwise provide more lines than before
        const maxLines = lines.length <= 200 ? lines.length : 200; // Increased from 120
        const previewLines = lines.slice(0, maxLines);
        const preview = previewLines.join("\n");
        const truncated = maxLines < lines.length ? ` (showing ${maxLines} of ${lines.length} lines)` : "";
        snippets.push(`--- ${path}${truncated} ---\n${preview}`);
        remainingBudget -= preview.length;
      } catch {
        snippets.push(`--- ${path} ---\n<file not found>`);
      }
    }

    return snippets.length ? `Existing file context:\n${snippets.join("\n\n")}` : "";
  }

  private parseWithRepair(candidate: string, raw: string): unknown {
    const attempts: Array<() => unknown> = [];
    const balancedCandidate = balanceJson(candidate);
    const balancedRaw = balanceJson(raw);
    const candidateSet = new Set<string>();
    candidateSet.add(candidate);
    candidateSet.add(balancedCandidate);

    attempts.push(() => JSON.parse(candidate));
    attempts.push(() => JSON.parse(balancedCandidate));
    attempts.push(() => JSON.parse(jsonrepair(candidate)));
    attempts.push(() => JSON.parse(jsonrepair(balancedCandidate)));
    attempts.push(() => JSON.parse(jsonrepair(raw)));
    attempts.push(() => JSON.parse(jsonrepair(balancedRaw)));

    const extracted = extractBestEffortJson(raw);
    if (extracted) {
      const balancedExtracted = balanceJson(extracted);
      candidateSet.add(extracted);
      candidateSet.add(balancedExtracted);
      attempts.push(() => JSON.parse(extracted));
      attempts.push(() => JSON.parse(jsonrepair(extracted)));
      attempts.push(() => JSON.parse(balancedExtracted));
      attempts.push(() => JSON.parse(jsonrepair(balancedExtracted)));
    }

    const additional = extractJsonCandidates(raw);
    for (const item of additional) {
      if (!candidateSet.has(item)) {
        candidateSet.add(item);
        const balancedItem = balanceJson(item);
        candidateSet.add(balancedItem);
        attempts.push(() => JSON.parse(item));
        attempts.push(() => JSON.parse(jsonrepair(item)));
        attempts.push(() => JSON.parse(balancedItem));
        attempts.push(() => JSON.parse(jsonrepair(balancedItem)));
      }
    }

    for (const attempt of attempts) {
      try {
        return attempt();
      } catch {
        continue;
      }
    }

    throw new Error(`Implementer returned invalid JSON after repair attempts. Raw response length=${raw.length}`);
  }

  private async retryInvalidJson(
    client: LLMClient,
    raw: string,
    parseError: Error,
    attemptNumber: number
  ): Promise<{ payload?: ImplementationPayload; usage?: TokenUsage; error?: Error; raw?: string }> {
    const snippet = truncateForError(raw, 5000); // Increased to give LLM more context
    const planText = this.context.plan.length
      ? this.context.plan.map((step, idx) => `${idx + 1}. ${step}`).join("\n")
      : "";

    // Make the retry prompt more explicit about the requirements
    const retrySystemPrompt = `You are a JSON repair specialist. Your ONLY job is to output valid, parseable JSON.

CRITICAL RULES:
1. Output ONLY the JSON object - no markdown, no fences, no explanations
2. Do not truncate the JSON - complete all arrays and objects
3. Ensure all strings are properly quoted and escaped
4. Balance all brackets and braces
5. Follow this exact schema:
${JSON_SCHEMA_HELP}

If the provided JSON is incomplete, complete it logically based on the original request.`;

    const retryMessages: ChatMessage[] = [
      { role: "system", content: retrySystemPrompt },
      {
        role: "user",
        content:
          [
            `Attempt ${attemptNumber}: Fix the invalid JSON below.`,
            `Original request: ${this.context.request}`,
            planText ? `Plan:\n${planText}` : "",
            `Parse error: ${parseError.message}`,
            `\nInvalid JSON to repair:\n${snippet}`,
            `\nOutput the corrected JSON (no fences, no explanation):`
          ]
            .filter(Boolean)
            .join("\n\n")
      }
    ];

    try {
      this.log("Requesting JSON repair completion.");
      const completion = await client.complete(retryMessages, {
        temperature: 0,
        maxOutputTokens: Math.max(4096, this.context.settings.defaultModel.maxOutputTokens ?? 2048) // Increased output tokens
      });

      const { payload, error } = this.parsePayloadSafe(completion.content);
      const usage: TokenUsage = {
        prompt: completion.usagePromptTokens ?? 0,
        completion: completion.usageCompletionTokens ?? 0
      };

      if (payload) {
        this.log("Repair completion parsed successfully.");
      } else if (error) {
        this.log(`Repair completion still invalid: ${error.message}`);
      }

      return {
        payload,
        usage,
        error,
        raw: completion.content
      };
    } catch (error) {
      this.log(`Repair completion request failed: ${(error as Error).message}`);
      return {
        error: error as Error,
        raw
      };
    }
  }

  private normalizeAction(action: ImplementationAction): ImplementationAction[] {
    if (Array.isArray(action.patches) && action.patches.length) {
      return action.patches.map((patch) => ({ ...action, patch }));
    }
    return [action];
  }

  private async applyActions(actions: ImplementationAction[], fsTool: FileSystemTool): Promise<FileMutation[]> {
    this.log(`Applying ${actions.length} action(s).`);
    const mutations: FileMutation[] = [];
    for (const action of actions) {
      if (!action.path) {
        throw new Error(`Action missing path: ${JSON.stringify(action)}`);
      }
      this.log(`→ ${action.type} @ ${action.path}`);
      if (action.type === "write_file") {
        if (typeof action.content !== "string") {
          throw new Error(`write_file action missing content: ${JSON.stringify(action)}`);
        }
        mutations.push(await fsTool.write(action.path, action.content));
      } else if (action.type === "modify_file") {
        const hasAnchor = !!(action.anchor && (action.anchor.exact || action.anchor.regex));
        const hasAnchorContent = typeof action.snippet === "string" || typeof action.replacement === "string";
        if (hasAnchor && hasAnchorContent) {
          try {
            this.log(`Attempting anchor-based modification for ${action.path}.`);
            mutations.push(await this.applyAnchoredModification(fsTool, action));
            this.log(`Anchor-based modification succeeded for ${action.path}.`);
            continue;
          } catch (anchorError) {
            this.log(`Anchor modification failed: ${(anchorError as Error).message}`);
            if (typeof action.patch === "string" && action.patch.trim()) {
              try {
                this.log(`Falling back to patch for ${action.path} after anchor failure.`);
                mutations.push(await this.applyPatch(fsTool, action.path, action.patch));
                continue;
              } catch (patchError) {
                this.log(`Patch fallback failed after anchor failure: ${(patchError as Error).message}`);
                throw anchorError instanceof Error ? anchorError : new Error(String(anchorError));
              }
            }
            throw anchorError instanceof Error ? anchorError : new Error(String(anchorError));
          }
        }
        if (typeof action.patch === "string" && action.patch.trim()) {
          this.log(`Applying patch for ${action.path}.`);
          mutations.push(await this.applyPatch(fsTool, action.path, action.patch));
          this.log(`Patch applied successfully for ${action.path}.`);
        } else if (typeof action.content === "string") {
          this.log(`No patch provided; writing full content for ${action.path}.`);
          mutations.push(await fsTool.write(action.path, action.content));
        } else {
          throw new Error(`modify_file action missing patch, anchor info, or content: ${JSON.stringify(action)}`);
        }
      } else if (action.type === "delete_path") {
        mutations.push(await fsTool.delete(action.path));
      } else {
        throw new Error(`Unsupported action type: ${(action as ImplementationAction).type}`);
      }
    }
    return mutations;
  }

  private async applyAnchoredModification(
    fsTool: FileSystemTool,
    action: ImplementationAction
  ): Promise<FileMutation> {
    if (!action.anchor) {
      throw new Error(`modify_file anchor missing for ${action.path}`);
    }
    const anchor = action.anchor;
    const mode = action.mode ?? (action.replacement ? "replace" : "insert_after");
    if (mode === "replace" && typeof action.replacement !== "string") {
      throw new Error(`modify_file replacement missing for replace mode: ${JSON.stringify(action)}`);
    }
    if (mode !== "replace" && typeof action.snippet !== "string") {
      throw new Error(`modify_file snippet missing for ${mode}: ${JSON.stringify(action)}`);
    }

    const originalRaw = await fsTool.read(action.path);
    const hadCRLF = /\r\n/.test(originalRaw);
    const original = hadCRLF ? originalRaw.replace(/\r\n/g, "\n") : originalRaw;
    const match = this.locateAnchor(original, anchor);
    if (!match) {
      throw new Error(`Unable to locate anchor for ${action.path}`);
    }

    let updated = original;
    if (mode === "replace") {
      const replacement = action.replacement ?? "";
      updated = original.slice(0, match.start) + replacement + original.slice(match.end);
    } else if (mode === "insert_after") {
      const snippet = action.snippet ?? "";
      updated = original.slice(0, match.end) + snippet + original.slice(match.end);
    } else if (mode === "insert_before") {
      const snippet = action.snippet ?? "";
      updated = original.slice(0, match.start) + snippet + original.slice(match.start);
    } else {
      throw new Error(`Unknown modify_file mode: ${mode}`);
    }

    if (action.ensure && !updated.includes(action.ensure)) {
      throw new Error(`Post-condition not met for ${action.path}`);
    }

    const finalContent = hadCRLF ? updated.replace(/\n/g, "\r\n") : updated;
    return fsTool.write(action.path, finalContent);
  }

  private locateAnchor(content: string, anchor: AnchorSpec): { start: number; end: number } | null {
    if (anchor.regex) {
      try {
        const regex = new RegExp(anchor.regex, "m");
        const match = regex.exec(content);
        if (match && match[0]) {
          return { start: match.index, end: match.index + match[0].length };
        }
      } catch {
        // ignore regex errors, fallback to exact
      }
    }

    if (anchor.exact) {
      const exact = anchor.exact;
      let index = content.indexOf(exact);
      if (index !== -1) {
        return { start: index, end: index + exact.length };
      }

      const trimmed = exact.trim();
      if (trimmed && trimmed !== exact) {
        index = content.indexOf(trimmed);
        if (index !== -1) {
          return { start: index, end: index + trimmed.length };
        }
      }

      const pattern = buildLooseRegex(exact);
      if (pattern) {
        try {
          const looseRegex = new RegExp(pattern, "mi");
          const match = looseRegex.exec(content);
          if (match && match[0]) {
            return { start: match.index, end: match.index + match[0].length };
          }
        } catch {
          // ignore
        }
      }
    }

    return null;
  }

  private async applyPatch(fsTool: FileSystemTool, targetPath: string, patch: string): Promise<FileMutation> {
    let existing: string;
    try {
      existing = await fsTool.read(targetPath);
    } catch (error) {
      throw new Error(`modify_file action referenced missing file ${targetPath}: ${(error as Error).message}`);
    }

    this.log(`Applying unified diff to ${targetPath}.`);
    const updated = this.applyUnifiedDiff(existing, patch, targetPath);
    this.log(`Unified diff succeeded for ${targetPath}.`);
    return fsTool.write(targetPath, updated);
  }

  private applyUnifiedDiff(original: string, patch: string, pathLabel: string): string {
    const trimmed = patch.trim();
    const baseNormalized = trimmed.startsWith("---") ? trimmed : `--- ${pathLabel}\n+++ ${pathLabel}\n${trimmed}`;
    const variantSet = new Set<string>();
    variantSet.add(baseNormalized);
    const sanitized = sanitizePatchArtifacts(baseNormalized);
    variantSet.add(sanitized);
    if (sanitized !== baseNormalized) {
      this.log(`Sanitized patch for ${pathLabel} to remove stray characters.`);
    }

    const attempts: Array<{
      source: string;
      patchString?: string;
      patchObjects?: ReturnType<typeof parsePatch>;
      restoreCRLF?: boolean;
      fuzz?: number;
    }> = [];

    const hasCRLF = /\r\n/.test(original);
    const normalizedLFSource = hasCRLF ? original.replace(/\r\n/g, "\n") : original;

    let lastPatchObjects: ReturnType<typeof parsePatch> | null = null;
    let lastSanitizedVariant: string | null = null;

    for (const variant of variantSet) {
      const patchCRLF = /\r\n/.test(variant);

      // Try exact match first (fuzz=0), then liberal matching (fuzz=2, then fuzz=4)
      attempts.push({ source: original, patchString: variant, fuzz: 0 });
      attempts.push({ source: original, patchString: variant, fuzz: 2 });
      attempts.push({ source: original, patchString: variant, fuzz: 4 }); // Added higher fuzz

      const normalizedVariant = patchCRLF ? variant.replace(/\r\n/g, "\n") : variant;
      attempts.push({
        source: normalizedLFSource,
        patchString: normalizedVariant,
        restoreCRLF: hasCRLF,
        fuzz: 0
      });
      attempts.push({
        source: normalizedLFSource,
        patchString: normalizedVariant,
        restoreCRLF: hasCRLF,
        fuzz: 2
      });
      attempts.push({
        source: normalizedLFSource,
        patchString: normalizedVariant,
        restoreCRLF: hasCRLF,
        fuzz: 4
      });

      try {
        const patchObjects = parsePatch(normalizedVariant);
        if (patchObjects.length) {
          lastPatchObjects = patchObjects;
          lastSanitizedVariant = normalizedVariant;
          this.log(`Parsed structured patch for ${pathLabel}.`);
          // Try applyPatch with parsed objects at different fuzz levels
          attempts.push({
            source: normalizedLFSource,
            patchObjects,
            restoreCRLF: hasCRLF,
            fuzz: 0
          });
          attempts.push({
            source: normalizedLFSource,
            patchObjects,
            restoreCRLF: hasCRLF,
            fuzz: 2
          });
          attempts.push({
            source: normalizedLFSource,
            patchObjects,
            restoreCRLF: hasCRLF,
            fuzz: 4
          });
        }
      } catch {
        // ignore parse errors and fall back to string attempts
        this.log(`parsePatch failed for ${pathLabel}; relying on string-level diff attempts.`);
      }
    }

    let lastError: Error | null = null;

    for (const attempt of attempts) {
      const fuzzFactor = attempt.fuzz ?? 0;
      if (attempt.patchString) {
        try {
          const applied = applyPatch(attempt.source, attempt.patchString, { fuzzFactor });
          if (applied !== false) {
            if (attempt.restoreCRLF) {
              return applied.replace(/\n/g, "\r\n");
            }
            return applied;
          }
          this.log(`applyPatch returned false (fuzz ${fuzzFactor}) for ${pathLabel}; trying next strategy.`);
        } catch (error) {
          lastError = error as Error;
          this.log(`applyPatch threw (fuzz ${fuzzFactor}) for ${pathLabel}: ${lastError.message}`);
          continue;
        }
      } else if (attempt.patchObjects && attempt.patchObjects.length) {
        let result = attempt.source;
        let ok = true;
        for (const patchObj of attempt.patchObjects) {
          try {
            const applied = applyPatch(result, patchObj, { fuzzFactor });
            if (applied === false) {
              ok = false;
              this.log(`applyPatch (object, fuzz ${fuzzFactor}) returned false for ${pathLabel}; abandoning object.`);
              break;
            }
            result = applied;
          } catch (error) {
            lastError = error as Error;
            ok = false;
            this.log(`applyPatch (object, fuzz ${fuzzFactor}) threw for ${pathLabel}: ${lastError.message}`);
            break;
          }
        }
        if (ok) {
          if (attempt.restoreCRLF) {
            return result.replace(/\n/g, "\r\n");
          }
          return result;
        }
      }
    }

    // All fuzzed attempts failed - try manual patch application as absolute last resort
    if (lastPatchObjects && lastPatchObjects.length) {
      this.log(`All fuzzed patch attempts failed for ${pathLabel}. Attempting manual patch application as last resort.`);
      try {
        const manualResult = applyPatchManually(normalizedLFSource, lastPatchObjects, (msg) => this.log(msg));
        if (manualResult !== null) {
          this.log(`Manual patch application succeeded for ${pathLabel}.`);
          const restored = hasCRLF ? manualResult.replace(/\n/g, "\r\n") : manualResult;
          return restored;
        }
        this.log(`Manual patch application failed to find safe insertion point for ${pathLabel}.`);
      } catch (manualError) {
        this.log(`Manual patch application threw error for ${pathLabel}: ${(manualError as Error).message}`);
      }
    }

    if (lastError) {
      if (lastPatchObjects && lastPatchObjects.length) {
        const instructions = formatPatchInstructions(lastPatchObjects, pathLabel);
        this.log(`All automated patch attempts exhausted for ${pathLabel}. Providing manual instructions.`);
        throw new Error(
          `Failed to apply patch for ${pathLabel}: ${lastError.message}\nSuggested manual edit steps:\n${instructions}`
        );
      }
      if (lastSanitizedVariant) {
        this.log(`All automated patch attempts exhausted for ${pathLabel}. Exposing sanitized patch for manual application.`);
        throw new Error(
          `Failed to apply patch for ${pathLabel}: ${lastError.message}\nSanitized patch:\n${lastSanitizedVariant}`
        );
      }
      throw new Error(`Failed to apply patch for ${pathLabel}: ${lastError.message}`);
    }

    throw new Error(`Failed to apply patch for ${pathLabel}`);
  }

  private async getWorkspaceSummary(): Promise<string | undefined> {
    if (typeof this.context.artifacts.workspaceSummary === "string") {
      return this.context.artifacts.workspaceSummary as string;
    }
    try {
      const summary = await buildWorkspaceSummary(this.context.workspace);
      this.context.artifacts.workspaceSummary = summary;
      return summary;
    } catch {
      return undefined;
    }
  }
}

function sanitizePatchArtifacts(patch: string): string {
  const lines = patch.split("\n");
  let changed = false;
  const cleaned: string[] = [];

  for (const line of lines) {
    if (!line) {
      cleaned.push(line);
      continue;
    }

    const normalizedLine = normalizeJsonText(line);
    const trimmed = normalizedLine.trim();

    if (/^["',\[\]\{}]+$/.test(trimmed) || trimmed === "\"" || trimmed === "'," || trimmed === '",') {
      changed = true;
      continue;
    }

    const firstChar = normalizedLine[0] ?? line[0];
    const isDiffContentLine = firstChar === "+" || firstChar === "-" || firstChar === " " || firstChar === "@" || firstChar === "\\";
    const isHeaderLine = PATCH_HEADER_PREFIXES.some((prefix) => normalizedLine.startsWith(prefix));

    if (trimmed === "") {
      const blank = normalizedLine.startsWith(" ") ? normalizedLine : " ";
      cleaned.push(blank);
      if (blank !== line) {
        changed = true;
      }
      continue;
    }

    if (isDiffContentLine) {
      const rebuilt = `${firstChar}${normalizedLine.slice(1)}`;
      cleaned.push(rebuilt);
      if (rebuilt !== line) {
        changed = true;
      }
      continue;
    }

    if (isHeaderLine) {
      cleaned.push(normalizedLine);
      if (normalizedLine !== line) {
        changed = true;
      }
      continue;
    }

    if ((normalizedLine.startsWith("\"") && normalizedLine.endsWith("\"")) || (normalizedLine.startsWith("'") && normalizedLine.endsWith("'"))) {
      const unquoted = normalizedLine.slice(1, -1);
      if (!unquoted) {
        changed = true;
        continue;
      }
      const unquotedFirst = unquoted[0];
      const unquotedIsDiff =
        unquotedFirst === "+" ||
        unquotedFirst === "-" ||
        unquotedFirst === " " ||
        unquotedFirst === "@" ||
        unquotedFirst === "\\" ||
        PATCH_HEADER_PREFIXES.some((prefix) => unquoted.startsWith(prefix));
      if (unquotedIsDiff) {
        cleaned.push(unquoted);
        changed = true;
        continue;
      }
      if (/^["',\[\]\{}]+$/.test(unquoted.trim())) {
        changed = true;
        continue;
      }
    }

    if (trimmed === "," || trimmed === "[" || trimmed === "]" || trimmed === "{" || trimmed === "}") {
      changed = true;
      continue;
    }

    const normalized = normalizedLine.startsWith(" ") ? normalizedLine : ` ${normalizedLine}`;
    cleaned.push(normalized);
    if (normalized !== line) {
      changed = true;
    }
  }

  return changed ? cleaned.join("\n") : patch;
}

function applyPatchManually(
  original: string,
  patches: ReturnType<typeof parsePatch>,
  log: (message: string) => void
): string | null {
  if (!patches.length) {
    return null;
  }

  let working = original.split("\n");

  for (const patch of patches) {
    log(`Manual patch: processing ${patch.hunks.length} hunk(s).`);
    let offset = 0;
    for (const hunk of patch.hunks) {
      const targetLines = hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("-"))
        .map((line) => line.slice(1));

      const replacementLines = hunk.lines
        .filter((line) => line.startsWith(" ") || line.startsWith("+"))
        .map((line) => line.slice(1));

      const removedLines = hunk.lines
        .filter((line) => line.startsWith("-"))
        .map((line) => line.slice(1));

      const contextLines = hunk.lines
        .filter((line) => line.startsWith(" "))
        .map((line) => line.slice(1));

      let index = -1;
      if (targetLines.length > 0) {
        index = findBestSequenceIndex(working, targetLines, removedLines, contextLines, hunk.oldStart, offset);
      } else {
        index = Math.max(0, Math.min(working.length, hunk.oldStart - 1 + offset));
      }

      if (index === -1) {
        index = Math.max(0, Math.min(working.length, hunk.oldStart - 1 + offset));
        log(
          `Manual patch: exact context not found for hunk starting at original line ${hunk.oldStart}; using positional index ${index}.`
        );
      }

      working.splice(index, targetLines.length, ...replacementLines);
      offset += replacementLines.length - targetLines.length;
    }
  }

  log("Manual patch: completed without conflicts.");
  return working.join("\n");
}

function findBestSequenceIndex(
  haystack: string[],
  needle: string[],
  removed: string[],
  context: string[],
  oldStart: number,
  offset: number
): number {
  if (!needle.length) {
    return Math.max(0, Math.min(haystack.length, oldStart - 1 + offset));
  }

  const approx = Math.max(0, Math.min(haystack.length, oldStart - 1 + offset));
  const candidates: number[] = [];

  for (let delta = 0; delta <= haystack.length; delta += 1) {
    const forward = approx + delta;
    const backward = approx - delta;
    if (forward < haystack.length) {
      candidates.push(forward);
    }
    if (delta !== 0 && backward >= 0) {
      candidates.push(backward);
    }
    if (candidates.length > haystack.length) {
      break;
    }
  }

  for (const candidate of candidates) {
    if (matchesAt(haystack, needle, candidate, false)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (matchesAt(haystack, needle, candidate, true)) {
      return candidate;
    }
  }

  if (removed.length) {
    const removedSequence = removed.filter((line) => line.trim().length > 0);
    if (removedSequence.length) {
      for (const candidate of candidates) {
        if (matchesPartial(haystack, removedSequence, candidate, true)) {
          return candidate;
        }
      }
    }
  }

  if (context.length) {
    const contextSequence = context.slice(0, Math.min(context.length, 3));
    if (contextSequence.length) {
      for (const candidate of candidates) {
        if (matchesPartial(haystack, contextSequence, candidate, true)) {
          return candidate;
        }
      }
    }
  }

  return -1;
}

function matchesAt(
  haystack: string[],
  needle: string[],
  index: number,
  useTrimmed: boolean
): boolean {
  if (index < 0 || index + needle.length > haystack.length) {
    return false;
  }
  for (let i = 0; i < needle.length; i += 1) {
    const hay = useTrimmed ? haystack[index + i].trim() : haystack[index + i];
    const need = useTrimmed ? needle[i].trim() : needle[i];
    if (hay !== need) {
      return false;
    }
  }
  return true;
}

function matchesPartial(haystack: string[], needle: string[], index: number, useTrimmed: boolean): boolean {
  if (!needle.length) {
    return false;
  }
  if (index < 0 || index >= haystack.length) {
    return false;
  }
  let matchCount = 0;
  let i = 0;
  let j = index;
  while (i < needle.length && j < haystack.length) {
    const hay = useTrimmed ? haystack[j].trim() : haystack[j];
    const need = useTrimmed ? needle[i].trim() : needle[i];
    if (hay === need) {
      matchCount += 1;
      i += 1;
      j += 1;
    } else {
      j += 1;
    }
    if (matchCount === needle.length) {
      return true;
    }
  }
  return matchCount === needle.length;
}

function truncateForError(text: string, maxLength = 800): string {
  const normalized = normalizeJsonText(text, true);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}…`;
}

function normalizeJsonText(input: string, trim = false): string {
  const cleaned = input
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\r\n/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ");

  return trim ? cleaned.trim() : cleaned;
}

function formatPatchInstructions(
  patches: ReturnType<typeof parsePatch>,
  pathLabel: string
): string {
  const steps: string[] = [];

  patches.forEach((patch, patchIndex) => {
    const fileLabel = patch.newFileName && patch.newFileName !== "" && patch.newFileName !== pathLabel
      ? patch.newFileName
      : pathLabel;
    patch.hunks.forEach((hunk, hunkIndex) => {
      const header = `• Hunk ${patchIndex + 1}.${hunkIndex + 1} near original line ${hunk.oldStart}`;
      const removed = hunk.lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
      const added = hunk.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
      const context = hunk.lines.filter((line) => line.startsWith(" ")).map((line) => line.slice(1));

      steps.push(header);
      if (context.length) {
        steps.push(`  Context: ${context.slice(0, 2).join(" | ")}`);
      }
      if (removed.length) {
        steps.push(`  Remove: ${removed.join(" | ")}`);
      }
      if (added.length) {
        steps.push(`  Add: ${added.join(" | ")}`);
      }
      if (!removed.length && added.length) {
        steps.push(`  (Insert the lines above at the indicated context.)`);
      }
      if (removed.length && !added.length) {
        steps.push(`  (Delete the lines above.)`);
      }
    });
  });

  if (!steps.length) {
    return `No detailed instructions generated for ${pathLabel}.`;
  }

  return [`File: ${pathLabel}`, ...steps].join("\n");
}

function extractJsonCandidates(raw: string): string[] {
  const results: string[] = [];
  const length = raw.length;
  for (let i = 0; i < length; i += 1) {
    if (raw[i] !== "{") {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < length; j += 1) {
      const ch = raw[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const snippet = raw.slice(i, j + 1);
          if (snippet.includes("\"actions\"")) {
            results.push(snippet.trim());
          }
          break;
        }
      }
    }
  }

  const unique = Array.from(new Set(results));
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

function extractBestEffortJson(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function balanceJson(input: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      if (stack.length === 0) {
        continue;
      }
      const top = stack[stack.length - 1];
      if ((top === "{" && ch === "}") || (top === "[" && ch === "]")) {
        stack.pop();
      }
    }
  }

  if (!stack.length) {
    return input;
  }

  const closing = stack
    .reverse()
    .map((ch) => (ch === "{" ? "}" : "]"))
    .join("");
  return input + closing;
}

function escapeForRegex(input: string): string {
  return input.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function buildLooseRegex(snippet: string): string | null {
  const trimmed = snippet.trim();
  if (!trimmed) {
    return null;
  }
  const escaped = escapeForRegex(trimmed);
  return escaped.replace(/\s+/g, "\\s+");
}
