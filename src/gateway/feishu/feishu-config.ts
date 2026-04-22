import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const feishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  domain: z.enum(["feishu", "lark"]).optional()
});

export interface FeishuGatewayConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}

export function resolveFeishuGatewayConfig(cwd: string): FeishuGatewayConfig {
  const configPath = join(cwd, ".auto-talon", "feishu.config.json");
  const fileConfig = existsSync(configPath)
    ? feishuConfigSchema.partial().parse(JSON.parse(readFileSync(configPath, "utf8")))
    : {};

  const config = feishuConfigSchema.parse({
    appId: process.env.AGENT_FEISHU_APP_ID ?? fileConfig.appId,
    appSecret: process.env.AGENT_FEISHU_APP_SECRET ?? fileConfig.appSecret,
    domain:
      process.env.AGENT_FEISHU_DOMAIN === "lark" || process.env.AGENT_FEISHU_DOMAIN === "feishu"
        ? process.env.AGENT_FEISHU_DOMAIN
        : fileConfig.domain
  });

  return {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain ?? "feishu"
  };
}
