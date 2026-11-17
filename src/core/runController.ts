import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { ForgeTools, MCP_SERVER_NAME, REVIEW_TOOL, ReviewOutcome } from './mcpServer';
import { Proposal } from './proposals';
import { TrueForgeGateway, TurnEvent, isEventDelta, isProviderFailure, mergeEventDelta } from './trueforge';

export interface ReviewRequest {
  proposals: Proposal[];
  summary: string;
  signal: AbortSignal;
}

/** The editor side of a human checkpoint: show the staged hunks, apply only accepted ones, report the result. */
export interface ReviewHost {
  review(req: ReviewRequest): Promise<ReviewOutcome & { dismissed?: boolean }>;
}

export type RunPhase = 'starting' | 'running' | 'review' | 'retrying' | 'done' | 'error' | 'cancelled' | 'fallback';

export interface ToolCallInfo {
  id: string;
  threadId: string;
  name: string;
  server?: string;
  args: Record<string, unknown>;
}

export interface RunListener {
  phase(phase: RunPhase, detail?: string): void;
  attempt(info: { agent: string; sessionId: string; sessionUrl: string; fallback: boolean }): void;
  text(info: { id: string; threadId: string; text: string; reasoning?: string }): void;
  toolCall(call: ToolCallInfo): void;
  toolResult(info: { toolCallId: string; threadId: string; name: string; content: string; isError: boolean }): void;
  thread(info: { threadId: string; title: string; status: 'created' | 'done' | 'error'; input?: string }): void;
  note(message: string): void;
  metrics(m: { totalTokens?: number; costUsd?: number }): void;
}

export interface RunRequest {
  message: string;
  title: string;
}

export interface RunResult {
  status: 'done' | 'error' | 'cancelled';
  message?: string;
  usedFallback: boolean;
  applied: boolean;
  sessionId?: string;
}

class Cancelled extends Error {}

const MAX_RATE_LIMIT_RESUMES = 4;
const RESUME_MESSAGE =
  'Continue the same task from where you stopped. The previous model call was rate-limited by the provider. Changes you staged with propose_file_change are still staged; do not re-read files you have already read unless you need different lines.';

/** If a failed turn was a transient provider condition (rate limit, overload), how long to wait before resuming. */
export function rateLimitDelayMs(message: string | undefined, attempt: number): number | undefined {
  // A slow-to-answer (overloaded) model gets one resume; an endpoint that keeps timing out is treated as down.
  if (message && /headers timeout|timed? ?out waiting/i.test(message)) return attempt < 1 ? 5000 : undefined;
  if (!message || !/\b(429|503)\b|rate.?limit|quota|resource.?exhausted|too many requests|high demand|overloaded|temporarily unavailable|ECONNRESET|socket hang up|other side closed/i.test(message)) return undefined;
  if (/per day|daily|PerDay/i.test(message)) return undefined;
  const m = /retry in ([\d.]+)\s*s/i.exec(message) ?? /retry[- ]after[:\s]+([\d.]+)/i.exec(message);
  const base = m ? Number(m[1]) * 1000 + 2000 : 10_000 * 2 ** attempt;
  return Math.min(Math.max(base, 3000), 65_000);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** Unwrap deferred-tool-loading meta calls (call_tool) so the UI and approval logic see the real MCP tool. */
export function normalizeToolCall(call: TrueForgeApi.ToolCall, threadId: string): ToolCallInfo {
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
  } catch {
    args = { _raw: call.function.arguments };
  }
  const info = call.toolInfo as { type: string; name: string; serverName?: string };
  let name = info?.name ?? call.function.name;
  let server = info?.type === 'mcp' ? info.serverName : undefined;
  if (info?.type !== 'mcp' && name === 'call_tool') {
    const innerName = (args.tool_name ?? args.toolName ?? args.name ?? args.tool) as string | undefined;
    const innerArgs = (args.arguments ?? args.input ?? args.args ?? args.body ?? args.params) as unknown;
    if (innerName) {
      name = innerName;
      server = (args.server_name ?? args.serverName ?? args.server) as string | undefined;
      args = typeof innerArgs === 'string' ? safeJson(innerArgs) : ((innerArgs as Record<string, unknown>) ?? {});
    }
  }
  return { id: call.id, threadId, name, server, args };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}

function contentText(c: TrueForgeApi.ModelMessageEvent['content']): string {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return c.map(p => ((p as { text?: string }).text ?? '')).join('');
}

export class RunController {
  private abort: AbortController | undefined;
  private sessionId: string | undefined;
  private cancelled = false;
  private active = false;

  constructor(
    private gateway: TrueForgeGateway,
    private tools: ForgeTools,
    private host: ReviewHost,
    private agents: () => { primary: string; fallback?: string },
  ) {}

  get running(): boolean {
    return this.active;
  }

  async run(req: RunRequest, listener: RunListener): Promise<RunResult> {
    if (this.active) throw new Error('A FORGE run is already in progress. Cancel it first.');
    this.active = true;
    this.cancelled = false;
    this.abort = new AbortController();
    this.tools.signal = this.abort.signal;
    this.tools.store.clear();
    this.tools.takeReviewOutcome();
    const { primary, fallback } = this.agents();
    const attempts = [primary, ...(fallback && fallback !== primary ? [fallback] : [])];
    let usedFallback = false;
    try {
      for (let i = 0; i < attempts.length; i++) {
        const agent = attempts[i]!;
        const isFallback = i > 0;
        usedFallback = isFallback;
        const r = await this.attempt(agent, isFallback, req, listener);
        if (r.status === 'error' && r.providerFailure && !r.applied && i < attempts.length - 1 && !this.cancelled) {
          this.tools.store.clear();
          listener.phase('fallback', `Primary model failed (${r.message ?? 'unknown error'}). Retrying with configured fallback agent "${attempts[i + 1]}"…`);
          continue;
        }
        if (r.status === 'error' && r.providerFailure && i === attempts.length - 1 && attempts.length === 1) {
          r.message = `${r.message ?? 'Model request failed'} — no fallback agent is configured (forge.fallbackAgent).`;
        }
        listener.phase(r.status, r.message);
        return { status: r.status, message: r.message, usedFallback, applied: r.applied, sessionId: this.sessionId };
      }
      return { status: 'error', message: 'no agent attempts configured', usedFallback, applied: false };
    } catch (e) {
      if (this.cancelled || e instanceof Cancelled) {
        const confirmed = await this.awaitServerCancel();
        listener.phase('cancelled', `Cancelled by user. No staged changes were applied.${confirmed ? ' TrueForge turn cancelled.' : ' (TrueForge did not confirm the cancel; the server may still be finishing the turn.)'}`);
        return { status: 'cancelled', usedFallback, applied: false, sessionId: this.sessionId };
      }
      const msg = describeError(e, this.gateway.baseUrl);
      listener.phase('error', msg);
      return { status: 'error', message: msg, usedFallback, applied: false, sessionId: this.sessionId };
    } finally {
      this.tools.store.clear();
      this.tools.takeReviewOutcome();
      this.tools.signal = undefined;
      this.active = false;
    }
  }

  /**
   * Cancel the active run. The TrueForge cancel (POST /sessions/{id}/cancel) is sent first, then the local stream,
   * review and commands are aborted; run() waits for the server's answer before reporting "cancelled".
   */
  async cancel(): Promise<void> {
    if (!this.active || this.cancelled) return;
    this.cancelled = true;
    this.serverCancel = this.sessionId
      ? this.gateway.cancel(this.sessionId).then(
          () => true,
          () => false,
        )
      : Promise.resolve(true);
    this.tools.runner.killAll();
    this.tools.store.clear();
    this.tools.takeReviewOutcome();
    this.abort?.abort();
    await this.serverCancel;
  }

  private serverCancel: Promise<boolean> | undefined;

  private async awaitServerCancel(): Promise<boolean> {
    if (!this.serverCancel) return true;
    return Promise.race([this.serverCancel, new Promise<boolean>(r => setTimeout(() => r(false), 5000))]);
  }

  private async attempt(agent: string, isFallback: boolean, req: RunRequest, l: RunListener) {
    const signal = this.abort!.signal;
    l.phase('starting', isFallback ? `Starting fallback agent ${agent}` : `Starting agent ${agent}`);
    const sessionId = await this.gateway.createSession(agent, req.title.slice(0, 120));
    this.sessionId = sessionId;
    this.check();
    l.attempt({ agent, sessionId, sessionUrl: this.gateway.sessionUrl(sessionId), fallback: isFallback });

    const events = new Map<string, TurnEvent>();
    const emittedCalls = new Set<string>();
    const callIndex = new Map<string, ToolCallInfo>();
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    let applied = false;
    let resumes = 0;
    let stream = await this.gateway.startTurn(sessionId, req.message, signal);
    l.phase('running');

    const emitCalls = (msg: TrueForgeApi.ModelMessageEvent) => {
      for (const c of msg.toolCalls ?? []) {
        if (!c.id || emittedCalls.has(c.id) || !c.function?.name) continue;
        const info = normalizeToolCall(c, msg.threadId);
        emittedCalls.add(c.id);
        callIndex.set(c.id, info);
        l.toolCall(info);
      }
    };
    const findCall = (id: string): ToolCallInfo | undefined => {
      if (callIndex.has(id)) return callIndex.get(id);
      for (const ev of events.values()) {
        if (ev.type === 'model.message') emitCalls(ev);
      }
      return callIndex.get(id);
    };

    for (;;) {
      const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
      let paused = false;
      let done: TrueForgeApi.TurnDoneEvent | undefined;
      for await (const ev of stream) {
        this.check();
        if (ev.id) lastEventId = ev.id;
        if (isEventDelta(ev)) {
          const base = events.get(ev.id) as TrueForgeApi.ModelMessageEvent | undefined;
          if (base) {
            mergeEventDelta(base, ev as TrueForgeApi.ModelMessageDeltaEvent);
            l.text({ id: base.id, threadId: base.threadId, text: contentText(base.content), reasoning: base.reasoningContent });
            if (base.finishReason) emitCalls(base);
          }
          continue;
        }
        events.set(ev.id, ev);
        switch (ev.type) {
          case 'turn.created':
            turnId = ev.turnId;
            break;
          case 'model.message':
            if (contentText(ev.content)) l.text({ id: ev.id, threadId: ev.threadId, text: contentText(ev.content), reasoning: ev.reasoningContent });
            if (ev.finishReason || (ev.toolCalls ?? []).some(c => c.function?.arguments)) emitCalls(ev);
            break;
          case 'tool.response': {
            const call = findCall(ev.toolCallId);
            const isError = ev.content.startsWith('ERROR:') || /"isError"\s*:\s*true/.test(ev.content);
            l.toolResult({ toolCallId: ev.toolCallId, threadId: ev.threadId, name: call?.name ?? 'tool', content: ev.content, isError });
            break;
          }
          case 'tool.approval_required':
            pendingApprovals.push(ev);
            break;
          case 'thread.created':
            l.thread({ threadId: ev.threadId, title: ev.title, status: 'created', input: ev.agentInfo?.input });
            break;
          case 'thread.done':
            l.thread({ threadId: ev.threadId, title: ev.title, status: ev.state.status === 'error' ? 'error' : 'done' });
            break;
          case 'thread.context_compaction_started':
            l.note('TrueForge is compacting earlier context to stay within the model window…');
            break;
          case 'tool.response_required':
            l.note('The agent asked a question; FORGE disables ask_user_questions, so the run cannot answer it.');
            break;
          case 'turn.update':
            if (ev.state.status === 'paused') paused = true;
            if (ev.state.status === 'paused' && (ev.state as { metrics?: TrueForgeApi.TurnMetrics }).metrics) {
              const m = (ev.state as { metrics?: TrueForgeApi.TurnMetrics }).metrics!;
              l.metrics({ totalTokens: m.totalTokens, costUsd: m.totalCostInUsd });
            }
            break;
          case 'turn.done':
            done = ev;
            break;
          default:
            break;
        }
        if (paused || done) break;
      }
      this.check();

      if (done) {
        const st = done.state;
        if (st.metrics) l.metrics({ totalTokens: st.metrics.totalTokens, costUsd: st.metrics.totalCostInUsd });
        if (st.status === 'done') {
          if (st.output) l.text({ id: st.output.id, threadId: st.output.threadId, text: contentText(st.output.content) });
          return { status: 'done' as const, applied, providerFailure: false };
        }
        if (st.status === 'cancelled') {
          return { status: 'cancelled' as const, message: `Turn cancelled (${st.reason}).`, applied, providerFailure: false };
        }
        const wait = rateLimitDelayMs(st.message, resumes);
        if (wait !== undefined && resumes < MAX_RATE_LIMIT_RESUMES) {
          resumes++;
          l.phase('retrying', `Provider rate-limited or overloaded; resuming the same TrueForge session in ${Math.round(wait / 1000)} s (attempt ${resumes}/${MAX_RATE_LIMIT_RESUMES}). Staged changes are kept.`);
          await sleep(wait, signal);
          this.check();
          stream = await this.gateway.startTurn(sessionId, RESUME_MESSAGE, signal);
          l.phase('running');
          continue;
        }
        return { status: 'error' as const, message: st.message, applied, providerFailure: isProviderFailure(st.message) };
      }
      if (!paused || !turnId) {
        return { status: 'error' as const, message: 'The TrueForge stream ended without turn.done.', applied, providerFailure: false };
      }

      const answers: TrueForgeApi.TurnUserEventMessage[] = [];
      let reviewHandled = false;
      for (const pending of pendingApprovals) {
        for (const ref of pending.toolCalls) {
          const call = findCall(ref.id);
          const threadId = pending.threadId ?? call?.threadId ?? 'main';
          if (!call || call.name !== REVIEW_TOOL || (call.server && call.server !== MCP_SERVER_NAME)) {
            answers.push({ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: { status: 'deny', reason: `FORGE only approves ${REVIEW_TOOL}; ${call?.name ?? 'this tool'} is not gated for humans.` } });
            continue;
          }
          if (reviewHandled) {
            answers.push({ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: { status: 'deny', reason: 'Duplicate review request; the staged changes were already reviewed.' } });
            continue;
          }
          reviewHandled = true;
          const decision = await this.reviewStaged(String(call.args.summary ?? ''), l, signal);
          if (decision.applied.length) {
            applied = true;
            this.tools.setReviewOutcome(decision);
            answers.push({ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: { status: 'allow' } });
          } else {
            const reason = decision.note ?? (decision.rejected.length ? `The user rejected every change: ${decision.rejected.map(r => `${r.path} (${r.reason})`).join('; ')}` : 'There were no staged changes to review. Stage edits with propose_file_change first.');
            answers.push({ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: { status: 'deny', reason } });
          }
        }
      }
      this.check();
      l.phase('running');
      stream = await this.gateway.subscribe(sessionId, turnId, lastEventId, signal);
      await this.gateway.sendApprovals(sessionId, turnId, answers);
    }
  }

  private async reviewStaged(summary: string, l: RunListener, signal: AbortSignal): Promise<ReviewOutcome> {
    const proposals = this.tools.store.list();
    if (!proposals.length) return { applied: [], rejected: [], note: 'There were no staged changes to review. Stage edits with propose_file_change first, then call submit_changes_for_review.' };
    l.phase('review', `${proposals.length} file(s) waiting for review`);
    const result = await this.host.review({ proposals, summary, signal });
    this.check();
    this.tools.store.clear();
    if (result.dismissed) return { applied: [], rejected: proposals.map(p => ({ path: p.path, reason: 'review closed without applying' })), note: 'The user closed the review without applying anything. Do not retry unless asked.' };
    return result;
  }

  private check(): void {
    if (this.cancelled) throw new Cancelled();
  }
}

export function describeError(e: unknown, baseUrl: string): string {
  const err = e as { message?: string; statusCode?: number; body?: unknown; cause?: { code?: string } };
  const msg = err?.message ?? String(e);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg) || err?.cause?.code === 'ECONNREFUSED') {
    return `Cannot reach TrueForge at ${baseUrl}. Start it with "npx @truefoundry/trueforge@latest" (see README).`;
  }
  if (err?.statusCode === 404 && /agent/i.test(JSON.stringify(err.body ?? ''))) {
    return `TrueForge agent not found. Run "FORGE: Set up TrueForge" to register the FORGE agents. (${msg})`;
  }
  const body = err?.body ? ` ${JSON.stringify(err.body).slice(0, 400)}` : '';
  return `${msg}${body}`;
}
