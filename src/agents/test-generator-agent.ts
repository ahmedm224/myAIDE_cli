import { Agent, AgentStatus, type AgentResult } from "./agent-base";
import { LLMClient, type ChatMessage } from "../llm/openai-client";

const SYSTEM_PROMPT = `You are a test generation specialist in a multi-agent coding assistant.
Your job is to generate comprehensive test cases for newly created or modified code.

RULES:
1. Analyze the implementation changes and identify what needs testing
2. Generate test files following the project's testing conventions
3. Include unit tests for functions, integration tests for APIs, and component tests for UI
4. Use existing test patterns from the codebase
5. Focus on edge cases, error handling, and critical paths
6. Return JSON with test file specifications

Response format:
{
  "tests": [
    {
      "path": "relative/path/to/test-file.test.ts",
      "content": "full test file content",
      "framework": "jest|mocha|vitest|etc",
      "coverage": ["function1", "function2"]
    }
  ],
  "summary": "brief description of test coverage"
}`;

interface TestSpec {
  path: string;
  content: string;
  framework: string;
  coverage: string[];
}

interface TestPayload {
  tests: TestSpec[];
  summary: string;
}

export class TestGeneratorAgent extends Agent {
  readonly name = "test-generator";
  readonly description = "Generates automated test cases for implemented changes.";

  async run(): Promise<AgentResult> {
    // Skip if no implementation mutations occurred
    const implementation = this.context.artifacts["implementation"] as { actions?: unknown[] } | undefined;
    if (!implementation || !implementation.actions || (implementation.actions as unknown[]).length === 0) {
      return {
        agent: this.name,
        status: AgentStatus.Skipped,
        summary: "No implementation changes to test."
      };
    }

    // Skip if tests were explicitly excluded in request
    if (this.context.request.toLowerCase().includes("skip tests") || this.context.request.toLowerCase().includes("no tests")) {
      return {
        agent: this.name,
        status: AgentStatus.Skipped,
        summary: "Test generation skipped per user request."
      };
    }

    try {
      const client = new LLMClient(this.context.settings);
      const myAIDEContent = this.getMyAIDEContent();
      const implementationSummary = this.getImplementationSummary();

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `USER REQUEST: ${this.context.request}`,
            myAIDEContent ? `\nPROJECT ARCHITECTURE:\n${myAIDEContent}` : "",
            `\nIMPLEMENTATION CHANGES:\n${implementationSummary}`,
            "\nGenerate appropriate test files (JSON only, no markdown fences):"
          ]
            .filter(Boolean)
            .join("\n")
        }
      ];

      const completion = await client.complete(messages, {
        temperature: 0.3,
        maxOutputTokens: 3000
      });

      this.context.usage.prompt += completion.usagePromptTokens ?? 0;
      this.context.usage.completion += completion.usageCompletionTokens ?? 0;

      const payload = this.parsePayload(completion.content);

      // Write test files
      const fsTool = this.context.filesystem;
      if (fsTool && payload.tests.length > 0) {
        for (const test of payload.tests) {
          try {
            await fsTool.write(test.path, test.content);
          } catch (error) {
            // Non-fatal - log and continue
            console.warn(`Failed to write test file ${test.path}: ${(error as Error).message}`);
          }
        }
      }

      return {
        agent: this.name,
        status: AgentStatus.Success,
        summary: `Generated ${payload.tests.length} test file(s): ${payload.summary}`,
        details: completion.content,
        completedPlanSteps: 1 // Tests count as 1 step
      };
    } catch (error) {
      return {
        agent: this.name,
        status: AgentStatus.Failure,
        summary: `Test generation failed: ${(error as Error).message}`
      };
    }
  }

  private parsePayload(raw: string): TestPayload {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      const match = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
      if (match) {
        cleaned = match[1].trim();
      }
    }

    try {
      const parsed = JSON.parse(cleaned);
      return {
        tests: Array.isArray(parsed.tests) ? parsed.tests : [],
        summary: typeof parsed.summary === "string" ? parsed.summary : "Tests generated"
      };
    } catch {
      return {
        tests: [],
        summary: "Failed to parse test specifications"
      };
    }
  }

  private getMyAIDEContent(): string {
    const content = this.context.artifacts["myAIDEContent"] as string | undefined;
    if (content) {
      return content.length > 1500 ? content.slice(0, 1500) + "\n..." : content;
    }
    return "";
  }

  private getImplementationSummary(): string {
    const impl = this.context.artifacts["implementation"] as { actions?: unknown[]; notes?: string } | undefined;
    if (!impl) {
      return "No implementation details available.";
    }

    const parts: string[] = [];
    if (impl.notes) {
      parts.push(`Summary: ${impl.notes}`);
    }
    if (impl.actions && Array.isArray(impl.actions)) {
      parts.push(`Changes: ${impl.actions.length} action(s)`);
    }

    return parts.join("\n");
  }
}