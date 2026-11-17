import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentTemplate, TrueForgeGateway, buildAgentSpec } from './trueforge';

export const DEFAULT_AGENTS = { primary: 'forge-coder', fallback: 'forge-coder-fallback' };

export function loadAgentTemplate(root: string): AgentTemplate {
  const def = JSON.parse(fs.readFileSync(path.join(root, 'trueforge', 'forge-agent.json'), 'utf8')) as Omit<AgentTemplate, 'instructions'>;
  const instructions = fs.readFileSync(path.join(root, 'trueforge', 'instructions.md'), 'utf8');
  return { ...def, instructions };
}

export interface SyncOptions {
  mcpUrl: string;
  primaryModel: string;
  fallbackModel?: string;
  primaryAgent: string;
  fallbackAgent: string;
}

/** Register the workspace MCP connector and save the primary/fallback agents in TrueForge. */
export async function syncForge(gateway: TrueForgeGateway, template: AgentTemplate, o: SyncOptions): Promise<string[]> {
  const log: string[] = [];
  const models = await gateway.listModels();
  for (const m of [o.primaryModel, o.fallbackModel].filter(Boolean) as string[]) {
    if (models.length && !models.includes(m)) log.push(`warning: model "${m}" is not in TrueForge's model list (${models.slice(0, 8).join(', ')}${models.length > 8 ? ', …' : ''})`);
  }
  log.push(`MCP connector forge-workspace -> ${o.mcpUrl}: ${await gateway.ensureMcpConnector(o.mcpUrl)}`);
  log.push(`agent ${o.primaryAgent} (${o.primaryModel}): ${await gateway.upsertAgent(o.primaryAgent, template.description, buildAgentSpec(template, o.primaryModel))}`);
  if (o.fallbackModel) {
    log.push(`agent ${o.fallbackAgent} (${o.fallbackModel}): ${await gateway.upsertAgent(o.fallbackAgent, `${template.description} (fallback model)`, buildAgentSpec(template, o.fallbackModel))}`);
  } else {
    log.push('no fallback model given; automatic fallback is disabled until one is configured');
  }
  return log;
}
