/**
 * Generates fixtures/eval-suites/long-context.v1.json with padded multi-file workspaces.
 * Run: node --import tsx scripts/generate-long-context-suite.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "fixtures", "eval-suites", "long-context.v1.json");

function padLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, "0")} long context filler`).join(
    "\n"
  );
}

function notesArrayJs(prefix: string, count: number): string {
  const lines = Array.from(
    { length: count },
    (_, i) => `  "${prefix}-${String(i).padStart(4, "0")} note"`
  );
  return `export const notes = [\n${lines.join(",\n")}\n];\n`;
}

function markdownPad(title: string, count: number): string {
  return `# ${title}\n\n${padLines(title.replace(/\s+/g, "_").toLowerCase(), count)}\n`;
}

const suite = {
  schemaVersion: 1 as const,
  id: "auto-talon-long-context",
  version: "1.0.0",
  description:
    "Eight long-context coding tasks with multi-file padded workspaces that require cross-file reading before edits. Used by the compaction ON/OFF A/B harness.",
  promptVersion: "runtime-0.1",
  toolSchemaVersion: "runtime-0.1",
  tasks: [
    {
      id: "lc_math_util_export",
      title: "Export add from a padded util module",
      input:
        "Read src/util/numbers.mjs and src/util/strings.mjs fully, then create src/math.mjs that exports add(a, b) returning a+b. Verify with a quick node check and summarize which util files you inspected.",
      category: "coding",
      difficulty: "medium" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "verification"],
      workspace: {
        files: {
          "package.json": "{\"type\":\"module\"}\n",
          "src/util/numbers.mjs": `${notesArrayJs("num", 80)}export function identity(n) { return n; }\n`,
          "src/util/strings.mjs": `${notesArrayJs("str", 80)}export function echo(s) { return s; }\n`,
          "docs/util-overview.md": markdownPad("Util Overview", 60)
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["src/math.mjs"],
          requiredPaths: ["src/math.mjs"]
        },
        {
          id: "hidden_test",
          type: "command" as const,
          command: "node --test .eval-hidden/math.test.mjs",
          hiddenFiles: {
            ".eval-hidden/math.test.mjs":
              "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/math.mjs'; test('adds', () => assert.equal(add(2, 3), 5));\n"
          }
        }
      ]
    },
    {
      id: "lc_slug_cross_file_fix",
      title: "Fix slugify using padded docs and module",
      input:
        "Read docs/slug-rules.md and src/slug.mjs. Fix slugify so it trims, lowercases, and replaces runs of spaces with one dash. Do not edit docs.",
      category: "coding",
      difficulty: "medium" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "debugging"],
      workspace: {
        files: {
          "package.json": "{\"type\":\"module\"}\n",
          "docs/slug-rules.md": `${markdownPad("Slug Rules", 70)}\n\n## Required behavior\n- trim leading/trailing whitespace\n- lowercase\n- replace runs of spaces with a single dash\n`,
          "src/slug.mjs": `${notesArrayJs("slug_pad", 70)}export const slugify = (value) => value;\n`,
          "src/unused-helpers.mjs": notesArrayJs("helper", 50)
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["src/slug.mjs"],
          requiredPaths: ["src/slug.mjs"]
        },
        {
          id: "hidden_test",
          type: "command" as const,
          command: "node --test .eval-hidden/slug.test.mjs",
          hiddenFiles: {
            ".eval-hidden/slug.test.mjs":
              "import test from 'node:test'; import assert from 'node:assert/strict'; import { slugify } from '../src/slug.mjs'; test('slug', () => assert.equal(slugify('  Hello   Agent  '), 'hello-agent'));\n"
          }
        }
      ]
    },
    {
      id: "lc_config_flag_from_notes",
      title: "Enable feature flag from padded notes",
      input:
        "Read notes/release.md and config/app.json. Enable featureFlag while keeping mode \"safe\" and valid JSON. Do not edit notes.",
      category: "coding",
      difficulty: "easy" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "configuration"],
      workspace: {
        files: {
          "notes/release.md": `${markdownPad("Release Notes", 90)}\n\n## Action required\nSet featureFlag to true in config/app.json. Keep mode safe.\n`,
          "config/app.json": "{\n  \"featureFlag\": false,\n  \"mode\": \"safe\"\n}\n",
          "config/legacy.json": `{\n  "notes": ${JSON.stringify(padLines("legacy", 40).split("\n"))}\n}\n`
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["config/app.json"],
          requiredPaths: ["config/app.json"]
        },
        {
          id: "state",
          type: "file_state" as const,
          path: "config/app.json",
          contains: ["\"featureFlag\": true", "\"mode\": \"safe\""]
        }
      ]
    },
    {
      id: "lc_parse_port_from_limits",
      title: "Repair parsePort using limits module",
      input:
        "Read src/limits.mjs and src/parse.mjs. Fix parsePort to accept integers from MIN_PORT through MAX_PORT and throw for invalid values. Only edit src/parse.mjs.",
      category: "coding",
      difficulty: "medium" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "boundary_conditions"],
      workspace: {
        files: {
          "package.json": "{\"type\":\"module\"}\n",
          "src/limits.mjs": `${notesArrayJs("limit", 75)}export const MIN_PORT = 1;\nexport const MAX_PORT = 65535;\n`,
          "src/parse.mjs": `${notesArrayJs("parse_pad", 60)}export function parsePort(value) { return Number(value); }\n`,
          "docs/ports.md": markdownPad("Port Handbook", 55)
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["src/parse.mjs"],
          requiredPaths: ["src/parse.mjs"]
        },
        {
          id: "hidden_test",
          type: "command" as const,
          command: "node --test .eval-hidden/parse.test.mjs",
          hiddenFiles: {
            ".eval-hidden/parse.test.mjs":
              "import test from 'node:test'; import assert from 'node:assert/strict'; import { parsePort } from '../src/parse.mjs'; test('valid', () => assert.equal(parsePort('443'), 443)); test('invalid', () => assert.throws(() => parsePort('0'))); test('high', () => assert.throws(() => parsePort('70000')));\n"
          }
        }
      ]
    },
    {
      id: "lc_merge_constants",
      title: "Create constants file from two padded modules",
      input:
        "Read src/a-constants.mjs and src/b-constants.mjs. Create src/merged.mjs that exports SERVICE_NAME and RETRY_LIMIT with the values defined in those modules. Do not change the source modules.",
      category: "coding",
      difficulty: "medium" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "synthesis"],
      workspace: {
        files: {
          "package.json": "{\"type\":\"module\"}\n",
          "src/a-constants.mjs": `${notesArrayJs("a_pad", 85)}export const SERVICE_NAME = "auto-talon";\n`,
          "src/b-constants.mjs": `${notesArrayJs("b_pad", 85)}export const RETRY_LIMIT = 3;\n`,
          "README.md": markdownPad("Constants Guide", 40)
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["src/merged.mjs"],
          requiredPaths: ["src/merged.mjs"]
        },
        {
          id: "hidden_test",
          type: "command" as const,
          command: "node --test .eval-hidden/merged.test.mjs",
          hiddenFiles: {
            ".eval-hidden/merged.test.mjs":
              "import test from 'node:test'; import assert from 'node:assert/strict'; import { SERVICE_NAME, RETRY_LIMIT } from '../src/merged.mjs'; test('merged', () => { assert.equal(SERVICE_NAME, 'auto-talon'); assert.equal(RETRY_LIMIT, 3); });\n"
          }
        }
      ]
    },
    {
      id: "lc_format_currency",
      title: "Fix currency formatter from padded spec",
      input:
        "Read specs/currency.md and src/format.mjs. Fix formatUsd so it prefixes with $ and keeps two decimal places. Only edit src/format.mjs.",
      category: "coding",
      difficulty: "medium" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "formatting"],
      workspace: {
        files: {
          "package.json": "{\"type\":\"module\"}\n",
          "specs/currency.md": `${markdownPad("Currency Spec", 80)}\n\n## formatUsd\nMust return values like $12.50 with exactly two decimals and a leading $.\n`,
          "src/format.mjs": `${notesArrayJs("fmt", 65)}export function formatUsd(value) { return String(value); }\n`,
          "src/noise.mjs": notesArrayJs("noise", 70)
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["src/format.mjs"],
          requiredPaths: ["src/format.mjs"]
        },
        {
          id: "hidden_test",
          type: "command" as const,
          command: "node --test .eval-hidden/format.test.mjs",
          hiddenFiles: {
            ".eval-hidden/format.test.mjs":
              "import test from 'node:test'; import assert from 'node:assert/strict'; import { formatUsd } from '../src/format.mjs'; test('usd', () => assert.equal(formatUsd(12.5), '$12.50'));\n"
          }
        }
      ]
    },
    {
      id: "lc_mode_from_policy",
      title: "Set runtime mode from padded policy",
      input:
        "Read policy/runtime.md and src/runtime-mode.mjs. Set MODE to \"production\" as required by the policy. Only edit src/runtime-mode.mjs.",
      category: "coding",
      difficulty: "easy" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "configuration"],
      workspace: {
        files: {
          "package.json": "{\"type\":\"module\"}\n",
          "policy/runtime.md": `${markdownPad("Runtime Policy", 95)}\n\n## Active mode\nMODE must be production.\n`,
          "policy/archive.md": markdownPad("Archived Policy", 50),
          "src/runtime-mode.mjs": `${notesArrayJs("mode_pad", 55)}export const MODE = "development";\n`
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["src/runtime-mode.mjs"],
          requiredPaths: ["src/runtime-mode.mjs"]
        },
        {
          id: "state",
          type: "file_state" as const,
          path: "src/runtime-mode.mjs",
          contains: ["export const MODE = \"production\""],
          notContains: ["export const MODE = \"development\""]
        }
      ]
    },
    {
      id: "lc_clamp_with_bounds",
      title: "Implement clamp using padded bounds module",
      input:
        "Read src/bounds.mjs and src/math-ops.mjs. Implement clamp(value) so it clamps to [LOWER, UPPER] from bounds. Only edit src/math-ops.mjs.",
      category: "coding",
      difficulty: "medium" as const,
      risk: "low" as const,
      timeoutMs: 180_000,
      capabilities: ["long_context", "coding", "verification"],
      workspace: {
        files: {
          "package.json": "{\"type\":\"module\"}\n",
          "src/bounds.mjs": `${notesArrayJs("bounds", 90)}export const LOWER = 0;\nexport const UPPER = 100;\n`,
          "src/math-ops.mjs": `${notesArrayJs("ops", 70)}export function clamp(value) { return value; }\n`,
          "docs/math.md": markdownPad("Math Ops", 45)
        }
      },
      scorers: [
        {
          id: "diff",
          type: "workspace_diff" as const,
          allowedPaths: ["src/math-ops.mjs"],
          requiredPaths: ["src/math-ops.mjs"]
        },
        {
          id: "hidden_test",
          type: "command" as const,
          command: "node --test .eval-hidden/clamp.test.mjs",
          hiddenFiles: {
            ".eval-hidden/clamp.test.mjs":
              "import test from 'node:test'; import assert from 'node:assert/strict'; import { clamp } from '../src/math-ops.mjs'; test('mid', () => assert.equal(clamp(50), 50)); test('low', () => assert.equal(clamp(-5), 0)); test('high', () => assert.equal(clamp(200), 100));\n"
          }
        }
      ]
    }
  ]
};

writeFileSync(outPath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
console.log(`Wrote ${outPath} with ${suite.tasks.length} tasks`);
