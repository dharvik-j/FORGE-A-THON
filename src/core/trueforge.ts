import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { MCP_SERVER_NAME } from './mcpServer';

export type TurnEvent = TrueForgeApi.TurnStreamingEvent;

export interface AgentTemplate {
  description: string;
  instructions: string;
  manifest: Omit<TrueForgeApi.AgentSpec, 'model' | 'instructions'>;
}

export interface ForgeAgentNames {
  primary: string;
  fallback: string;
}

/**
 * Thin adapter over the official TrueForge TypeScript SDK (v0.185). Every call here maps 1:1 to a documented
 * SDK method; the rest of FORGE depends only on this class.
 */
export class TrueForgeGateway {
  readonly client: TrueForge;

  constructor(readonly baseUrl: string) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 900 });
  }

  /** GET /api/v1/models — also used as the connectivity check. */
  async listModels(): Promise<string[]> {
    const r = await this.client.models.list();
    return ((r.data ?? []) as { id?: string; name?: string; fqn?: string }[]).map(m => m.id ?? m.fqn ?? m.name ?? '').filter(Boolean);
  }

  /** POST|PUT /api/v1/settings/mcp-servers — registers the in-extension MCP endpoint as a remote connector. */
  async ensureMcpConnector(url: string): Promise<'created' | 'updated'> {
    const manifest: TrueForgeApi.McpServerManifest = {
      type: 'remote',
      name: MCP_SERVER_NAME,
      url,
      description: 'FORGE workspace tools: repository retrieval, search, symbols, file reads, staged edits with human review, and test commands for the folder open in VS Code.',
    } as TrueForgeApi.McpServerManifest;
    let exists = false;
    try {
      await this.client.settings.mcpServers.get(MCP_SERVER_NAME);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      await this.client.settings.mcpServers.createOrUpdate({ manifest } as TrueForgeApi.settings.UpdateMcpServerRequest);
      return 'updated';
    }
    await this.client.settings.mcpServers.create({ manifest });
    return 'created';
  }

  /** Create or update a saved agent (POST /api/v1/agents or PUT /api/v1/agents/{id}). */
  async upsertAgent(name: string, description: string, manifest: TrueForgeApi.AgentSpec): Promise<'created' | 'updated'> {
    const existing = await this.findAgent(name);
    if (existing) {
      await this.client.agents.update(existing.id, { description, manifest });
      return 'updated';
    }
    await this.client.agents.create({ name, description, manifest });
    return 'created';
  }

  async findAgent(name: string): Promise<TrueForgeApi.Agent | undefined> {
    const page = await this.client.agents.list();
    for await (const a of page) if (a.name === name) return a;
    return undefined;
  }

  async createSession(agentName: string, title: string): Promise<string> {
    void title;
    const r = await this.client.sessions.create({ agent: { name: agentName } });
    return r.data.id;
  }

  async startTurn(sessionId: string, message: string, signal: AbortSignal): Promise<AsyncIterable<TurnEvent>> {
    return await this.client.sessions.createTurnStream(
      sessionId,
      { input: [{ type: 'user.message', content: message }] },
      { abortSignal: signal, timeoutInSeconds: 1800 },
    );
  }

  async subscribe(sessionId: string, turnId: string, afterEventId: string | undefined, signal: AbortSignal): Promise<AsyncIterable<TurnEvent>> {
    return await this.client.sessions.subscribeToTurn(sessionId, turnId, afterEventId ? { afterEventId } : {}, { abortSignal: signal, timeoutInSeconds: 1800 });
  }

  async sendApprovals(sessionId: string, turnId: string, events: TrueForgeApi.TurnUserEventMessage[]): Promise<void> {
    await this.client.sessions.createTurnEvents(sessionId, turnId, { events });
  }

  /** POST /api/v1/sessions/{id}/cancel — stops the active turn (running or paused). Idempotent. */
  async cancel(sessionId: string): Promise<void> {
    await this.client.sessions.cancel(sessionId);
  }

  sessionUrl(sessionId: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/sessions/${sessionId}`;
  }
}

export { isEventDelta, mergeEventDelta };

/** Build the agent spec that is saved in TrueForge from the template stored in the repository. */
export function buildAgentSpec(template: AgentTemplate, model: string): TrueForgeApi.AgentSpec {
  return { ...template.manifest, model: { ...(template.manifest as { model?: object }).model, name: model }, instructions: template.instructions } as TrueForgeApi.AgentSpec;
}

/**
 * A turn that ended in `error` is treated as a model/provider failure (eligible for fallback) when its message
 * looks like an upstream model problem. Tool, review and user-cancel outcomes are never classified this way.
 */
export function isProviderFailure(message: string | undefined): boolean {
  if (!message) return true;
  return /\b(401|402|403|404|408|409|429|5\d\d)\b|api[ _-]?key|unauthori[sz]ed|authenticat|forbidden|permission|invalid.*(key|token|credential)|credential|quota|rate.?limit|overloaded|unavailable|timed? ?out|timeout|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|network|socket|connect|provider|model|upstream|bad gateway|service/i.test(
    message,
  );
}
