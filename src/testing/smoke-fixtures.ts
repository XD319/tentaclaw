import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const traceExpectationsSchema = z.object({
  expectApproval: z.boolean(),
  expectMemoryRecall: z.boolean(),
  expectPolicyTrace: z.boolean(),
  expectSessionCompact: z.boolean(),
  mustExplainContinuation: z.boolean(),
  mustExplainGoal: z.boolean(),
  mustExplainToolReason: z.boolean(),
  mustSummarizeToolResults: z.boolean()
});

const smokeTaskFixtureSchema = z.object({
  acceptableResult: z.array(z.string().min(1)).min(1),
  category: z.enum([
    "single_step_productivity",
    "multi_turn_execution",
    "long_context_execution"
  ]),
  expectedBehavior: z.array(z.string().min(1)).min(1),
  input: z.string().min(1),
  profile: z.enum(["executor", "planner", "reviewer"]).default("executor"),
  scriptId: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string().min(1),
  traceExpectations: traceExpectationsSchema
});

export type SmokeTaskFixture = z.infer<typeof smokeTaskFixtureSchema>;
export type SmokeTaskTraceExpectations = z.infer<typeof traceExpectationsSchema>;

const smokeTaskFixtureListSchema = z.array(smokeTaskFixtureSchema).min(1);
const currentDirectory = dirname(fileURLToPath(import.meta.url));

export function defaultSmokeFixturePath(): string {
  return resolve(currentDirectory, "../../fixtures/runtime-smoke-tasks.json");
}

export function loadSmokeTaskFixtures(fixturePath = defaultSmokeFixturePath()): SmokeTaskFixture[] {
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Smoke task fixture file was not found at ${fixturePath}. The default fixtures are maintainer validation assets in the source repository and are not included in the npm package. Pass an explicit fixture path when running smoke or eval from an installed package.`
    );
  }
  const content = readFileSync(fixturePath, "utf8");
  return smokeTaskFixtureListSchema.parse(JSON.parse(content));
}
