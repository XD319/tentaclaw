import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import { requireHttpAuth } from "../core/http-auth.js";
import {
  setupProviderConfig,
  useProviderConfig,
  type ProviderConfigScope
} from "../providers/config.js";
import { SUPPORTED_PROVIDER_NAMES } from "../providers/provider-registry.js";
import type { AgentApplicationService } from "../runtime/application-service.js";
import { resolveDefaultReviewerId, resolveDefaultUserId } from "../runtime/runtime-identity.js";
import type {
  ApprovalAllowScope,
  InboxCategory,
  InboxStatus,
  JsonObject
} from "../types/index.js";
import { optionalField, readJsonBody, readOptionalString, readString, writeJson } from "./http-util.js";
import { publicConfiguredProviders, publicExperienceList, publicInboxList, publicMemoryList, publicModelSelectionView, publicScheduleList, publicTaskList } from "./public-views.js";
import { tryServeWebAsset } from "./static-files.js";
import { parseInteractionMode, type SessionTurnManager } from "./turn-manager.js";

const SESSION_COOKIE_PATH = /^\/v1\/sessions\/([^/]+)$/u;
const SESSION_MODEL_PATH = /^\/v1\/sessions\/([^/]+)\/model$/u;
const SESSION_MESSAGES_PATH = /^\/v1\/sessions\/([^/]+)\/messages$/u;
const SESSION_CONTINUE_PATH = /^\/v1\/sessions\/([^/]+)\/continue$/u;
const SESSION_TURNS_PATH = /^\/v1\/sessions\/([^/]+)\/turns$/u;
const SESSION_BRANCH_PATH = /^\/v1\/sessions\/([^/]+)\/branch$/u;
const SESSION_HANDOFF_PATH = /^\/v1\/sessions\/([^/]+)\/handoff$/u;
const SESSION_CHANGES_PATH = /^\/v1\/sessions\/([^/]+)\/changes$/u;
const SESSION_TODOS_PATH = /^\/v1\/sessions\/([^/]+)\/todos$/u;
const SESSION_COMPACT_PATH = /^\/v1\/sessions\/([^/]+)\/compact$/u;
const SESSION_BUDGET_PATH = /^\/v1\/sessions\/([^/]+)\/budget$/u;
const TASK_EVENTS_PATH = /^\/v1\/tasks\/([^/]+)\/events$/u;
const TASK_STOP_PATH = /^\/v1\/tasks\/([^/]+)\/stop$/u;
const TASK_TRACE_PATH = /^\/v1\/tasks\/([^/]+)\/trace$/u;
const TASK_PATH = /^\/v1\/tasks\/([^/]+)$/u;
const ARTIFACT_ROLLBACK_PATH = /^\/v1\/artifacts\/([^/]+)\/rollback$/u;
const APPROVAL_RESOLVE_PATH = /^\/v1\/approvals\/([^/]+)\/resolve$/u;
const CLARIFY_ANSWER_PATH = /^\/v1\/clarify\/([^/]+)\/answer$/u;
const CLARIFY_CANCEL_PATH = /^\/v1\/clarify\/([^/]+)\/cancel$/u;
const INBOX_ITEM_PATH = /^\/v1\/inbox\/([^/]+)$/u;
const INBOX_DONE_PATH = /^\/v1\/inbox\/([^/]+)\/done$/u;
const INBOX_DISMISS_PATH = /^\/v1\/inbox\/([^/]+)\/dismiss$/u;
const NEXT_DONE_PATH = /^\/v1\/next\/([^/]+)\/done$/u;
const NEXT_BLOCK_PATH = /^\/v1\/next\/([^/]+)\/block$/u;
const COMMITMENT_COMPLETE_PATH = /^\/v1\/commitments\/([^/]+)\/complete$/u;
const COMMITMENT_BLOCK_PATH = /^\/v1\/commitments\/([^/]+)\/block$/u;
const SCHEDULE_PATH = /^\/v1\/schedules\/([^/]+)$/u;
const SCHEDULE_PAUSE_PATH = /^\/v1\/schedules\/([^/]+)\/pause$/u;
const SCHEDULE_RESUME_PATH = /^\/v1\/schedules\/([^/]+)\/resume$/u;
const SCHEDULE_RUN_PATH = /^\/v1\/schedules\/([^/]+)\/run-now$/u;
const SCHEDULE_RUNS_PATH = /^\/v1\/schedules\/([^/]+)\/runs$/u;
const MEMORY_ITEM_PATH = /^\/v1\/memory\/([^/]+)$/u;
const MEMORY_FORGET_PATH = /^\/v1\/memory\/([^/]+)\/forget$/u;
const SKILL_ENABLE_PATH = /^\/v1\/skills\/([^/]+)\/enable$/u;
const SKILL_DISABLE_PATH = /^\/v1\/skills\/([^/]+)\/disable$/u;

export interface SessionApiRouterOptions {
  cwd: string;
  service: AgentApplicationService;
  turns: SessionTurnManager;
}

export async function handleSessionApiRequest(
  options: SessionApiRouterOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  if (method === "GET" && !url.pathname.startsWith("/v1/")) {
    if (tryServeWebAsset(url.pathname, options.cwd, response)) {
      return;
    }
    writeJson(response, 404, { error: "not_found" });
    return;
  }

  const auth = requireHttpAuth(request, options.cwd);
  if (!auth.authorized) {
    writeJson(response, 401, { error: "unauthorized", message: auth.message });
    return;
  }

  try {
    const handled = await dispatchAuthenticated(options, request, response, method, url);
    if (!handled) {
      writeJson(response, 404, { error: "not_found" });
    }
  } catch (error) {
    writeJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function dispatchAuthenticated(
  options: SessionApiRouterOptions,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL
): Promise<boolean> {
  const { cwd, service, turns } = options;
  const userId = resolveDefaultUserId();
  const reviewerId = resolveDefaultReviewerId();

  if (method === "GET" && url.pathname === "/v1/bootstrap") {
    const provider = service.currentProvider();
    writeJson(response, 200, {
      catalog: SUPPORTED_PROVIDER_NAMES,
      configuredProviders: publicConfiguredProviders(service.listConfiguredProviders()),
      models: publicModelSelectionView(service.modelSelectionView()),
      provider: {
        configured: provider.configured !== false,
        displayName: provider.displayName,
        model: provider.model,
        name: provider.name
      },
      providers: service.listProviders().map((entry) => ({
        displayName: entry.displayName,
        name: entry.name,
        transport: entry.transport
      })),
      userId,
      workspaceRoot: cwd
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/providers/setup") {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const name = readString(body.name);
    if (name === null) {
      writeJson(response, 400, { error: "name_required" });
      return true;
    }
    const scope = body.workspace === true ? "workspace" : "user";
    const result = setupProviderConfig(name, {
      cwd,
      scope,
      ...optionalProviderWrite(body)
    });
    await service.switchProvider({
      persist: scope,
      selection: result.model !== null ? `${result.providerName}:${result.model}` : result.providerName
    });
    writeJson(response, 200, { provider: sanitizeProvider(service.currentProvider()), result });
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/providers/use") {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const name = readString(body.name);
    if (name === null) {
      writeJson(response, 400, { error: "name_required" });
      return true;
    }
    const scope: ProviderConfigScope = body.workspace === true ? "workspace" : "user";
    const result = useProviderConfig(name, { cwd, scope });
    await service.switchProvider({
      persist: scope,
      selection: result.model !== null ? `${result.providerName}:${result.model}` : result.providerName
    });
    writeJson(response, 200, { provider: sanitizeProvider(service.currentProvider()), result });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/models") {
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    if (sessionId !== undefined && service.findSession(sessionId) === null) {
      writeJson(response, 404, { error: "session_not_found" });
      return true;
    }
    writeJson(response, 200, publicModelSelectionView(service.modelSelectionView(sessionId)));
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/sessions") {
    const ownerUserId = url.searchParams.get("ownerUserId") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const entries = service.listSessionIndex({
      ...(ownerUserId !== undefined ? { ownerUserId } : {}),
      ...(status === "active" || status === "archived" || status === "deleted" ? { status } : {})
    });
    writeJson(response, 200, { sessions: entries });
    return true;
  }

  if (method === "POST" && url.pathname === "/v1/sessions") {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const session = service.createSession({
      agentProfileId: "executor",
      cwd,
      metadata: { source: "web" },
      ownerUserId: userId,
      providerName: service.currentProvider().name,
      ...optionalField("title", readOptionalString(body.title))
    });
    writeJson(response, 201, { session });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/sessions/search") {
    const query = url.searchParams.get("q") ?? "";
    writeJson(response, 200, { hits: service.searchSessionMessages({ query, limit: 20 }), query });
    return true;
  }

  const sessionMatch = url.pathname.match(SESSION_COOKIE_PATH);
  if (method === "GET" && sessionMatch !== null) {
    return writeSessionDetail(service, response, decodeURIComponent(sessionMatch[1] ?? ""));
  }
  if (method === "PATCH" && sessionMatch !== null) {
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    if (service.findSession(sessionId) === null) {
      writeJson(response, 404, { error: "session_not_found" });
      return true;
    }
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    if (body.status === "archived") {
      writeJson(response, 200, { session: service.archiveSession(sessionId) });
      return true;
    }
    const title = readString(body.title);
    if (title === null) {
      writeJson(response, 400, { error: "title_required" });
      return true;
    }
    writeJson(response, 200, { session: service.updateSessionTitle(sessionId, title) });
    return true;
  }

  const modelMatch = url.pathname.match(SESSION_MODEL_PATH);
  if (method === "PATCH" && modelMatch !== null) {
    return handleSessionModel(service, request, response, decodeURIComponent(modelMatch[1] ?? ""));
  }

  const messagesMatch = url.pathname.match(SESSION_MESSAGES_PATH);
  if (method === "GET" && messagesMatch !== null) {
    const sessionId = decodeURIComponent(messagesMatch[1] ?? "");
    const uiState = service.loadSessionUiState(sessionId);
    if (uiState === null) {
      writeJson(response, 404, { error: "session_not_found" });
      return true;
    }
    writeJson(response, 200, uiState);
    return true;
  }

  const continueMatch = url.pathname.match(SESSION_CONTINUE_PATH);
  if (method === "POST" && continueMatch !== null) {
    const sessionId = decodeURIComponent(continueMatch[1] ?? "");
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const input = typeof body.input === "string" ? body.input : "";
    if (input.trim().length === 0) {
      writeJson(response, 400, { error: "input_required" });
      return true;
    }
    const result = await service.continueSession(sessionId, input);
    writeJson(response, 200, {
      output: result.output,
      status: result.task.status,
      taskId: result.task.taskId
    });
    return true;
  }

  const turnsMatch = url.pathname.match(SESSION_TURNS_PATH);
  if (method === "POST" && turnsMatch !== null) {
    const sessionId = decodeURIComponent(turnsMatch[1] ?? "");
    if (service.findSession(sessionId) === null) {
      writeJson(response, 404, { error: "session_not_found" });
      return true;
    }
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const input = typeof body.input === "string" ? body.input : "";
    if (input.trim().length === 0) {
      writeJson(response, 400, { error: "input_required" });
      return true;
    }
    const mode = parseInteractionMode(body.interactionMode);
    const overrides = mode === undefined ? {} : { interactionMode: mode };
    const turn = turns.start(service, sessionId, input, {
      ...overrides,
      metadata: { source: "web" }
    });
    writeJson(response, 202, { sessionId, taskId: turn.taskId });
    return true;
  }

  const branchMatch = url.pathname.match(SESSION_BRANCH_PATH);
  if (method === "POST" && branchMatch !== null) {
    const sourceSessionId = decodeURIComponent(branchMatch[1] ?? "");
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const session = service.branchSession({
      agentProfileId: "executor",
      cwd,
      ownerUserId: userId,
      sourceSessionId,
      ...optionalField("title", readOptionalString(body.title))
    });
    writeJson(response, 201, { session });
    return true;
  }

  const handoffMatch = url.pathname.match(SESSION_HANDOFF_PATH);
  if (method === "POST" && handoffMatch !== null) {
    const runtimeSessionId = decodeURIComponent(handoffMatch[1] ?? "");
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const adapterId = readString(body.adapterId);
    const externalSessionId = readString(body.externalSessionId);
    if (adapterId === null || externalSessionId === null) {
      writeJson(response, 400, { error: "adapter_and_external_session_required" });
      return true;
    }
    writeJson(response, 200, {
      result: service.handoffSession({
        adapterId,
        externalSessionId,
        ownerUserId: userId,
        runtimeSessionId,
        runtimeUserId: userId,
        source: "web"
      })
    });
    return true;
  }

  const changesMatch = url.pathname.match(SESSION_CHANGES_PATH);
  if (method === "GET" && changesMatch !== null) {
    const sessionId = decodeURIComponent(changesMatch[1] ?? "");
    const session = service.findSession(sessionId);
    if (session === null) {
      writeJson(response, 404, { error: "session_not_found" });
      return true;
    }
    const detail = service.showSession(sessionId);
    const changes = detail.tasks.flatMap((entry) =>
      service.listArtifacts(entry.taskId).filter((artifact) => artifact.artifactType === "file")
    );
    writeJson(response, 200, { changes });
    return true;
  }

  const todosMatch = url.pathname.match(SESSION_TODOS_PATH);
  if (method === "GET" && todosMatch !== null) {
    writeJson(response, 200, { todos: service.getSessionTodos(decodeURIComponent(todosMatch[1] ?? "")) });
    return true;
  }

  const compactMatch = url.pathname.match(SESSION_COMPACT_PATH);
  if (method === "POST" && compactMatch !== null) {
    const sessionId = decodeURIComponent(compactMatch[1] ?? "");
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const latest = service.showSession(sessionId).tasks.at(-1);
    if (latest === undefined) {
      writeJson(response, 404, { error: "task_not_found" });
      return true;
    }
    const focus = readOptionalString(body.focusTopic);
    service.requestManualCompact(latest.taskId, focus);
    writeJson(response, 200, { ok: true, taskId: latest.taskId });
    return true;
  }

  const budgetMatch = url.pathname.match(SESSION_BUDGET_PATH);
  if (method === "GET" && budgetMatch !== null) {
    writeJson(response, 200, service.budgetReport("session", decodeURIComponent(budgetMatch[1] ?? "")));
    return true;
  }

  const eventsMatch = url.pathname.match(TASK_EVENTS_PATH);
  if (method === "GET" && eventsMatch !== null) {
    return startTaskEventStream(service, turns, response, request, decodeURIComponent(eventsMatch[1] ?? ""));
  }

  const stopMatch = url.pathname.match(TASK_STOP_PATH);
  if (method === "POST" && stopMatch !== null) {
    const taskId = decodeURIComponent(stopMatch[1] ?? "");
    const stopped = turns.stop(taskId);
    writeJson(response, stopped ? 200 : 404, stopped ? { ok: true, taskId } : { error: "turn_not_found" });
    return true;
  }

  const traceMatch = url.pathname.match(TASK_TRACE_PATH);
  if (method === "GET" && traceMatch !== null) {
    const taskId = decodeURIComponent(traceMatch[1] ?? "");
    writeJson(response, 200, { timeline: service.taskTimeline(taskId), trace: service.traceTask(taskId) });
    return true;
  }

  const taskMatch = url.pathname.match(TASK_PATH);
  if (method === "GET" && url.pathname === "/v1/tasks") {
    writeJson(response, 200, { tasks: publicTaskList(service.listTasks()) });
    return true;
  }
  if (method === "GET" && taskMatch !== null) {
    const taskId = decodeURIComponent(taskMatch[1] ?? "");
    const task = service.listTasks().find((entry) => entry.taskId === taskId);
    if (task === undefined) {
      writeJson(response, 404, { error: "task_not_found" });
      return true;
    }
    writeJson(response, 200, {
      task: {
        sessionId: task.sessionId ?? null,
        status: task.status,
        taskId: task.taskId
      }
    });
    return true;
  }

  const rollbackMatch = url.pathname.match(ARTIFACT_ROLLBACK_PATH);
  if (method === "POST" && rollbackMatch !== null) {
    const result = await service.rollbackFileArtifact(decodeURIComponent(rollbackMatch[1] ?? ""));
    writeJson(response, 200, result);
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/approvals/pending") {
    const sessionId = url.searchParams.get("sessionId");
    const taskIds = sessionId === null
      ? null
      : new Set(service.listTasks().filter((task) => task.sessionId === sessionId).map((task) => task.taskId));
    const approvals = service.listPendingApprovals().filter((approval) => taskIds === null || taskIds.has(approval.taskId));
    writeJson(response, 200, { approvals });
    return true;
  }
  const approvalMatch = url.pathname.match(APPROVAL_RESOLVE_PATH);
  if (method === "POST" && approvalMatch !== null) {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const action = body.action === "deny" ? "deny" : body.action === "allow" ? "allow" : null;
    if (action === null) {
      writeJson(response, 400, { error: "action_required" });
      return true;
    }
    const allowScope = parseAllowScope(body.allowScope);
    const result = await service.resolveApproval(
      decodeURIComponent(approvalMatch[1] ?? ""),
      action,
      reviewerId,
      allowScope
    );
    writeJson(response, 200, result);
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/clarify/pending") {
    const sessionId = url.searchParams.get("sessionId");
    const taskIds = sessionId === null
      ? null
      : new Set(service.listTasks().filter((task) => task.sessionId === sessionId).map((task) => task.taskId));
    const prompts = service.listPendingClarifyPrompts().filter((prompt) => taskIds === null || taskIds.has(prompt.taskId));
    writeJson(response, 200, { prompts });
    return true;
  }
  const clarifyAnswer = url.pathname.match(CLARIFY_ANSWER_PATH);
  if (method === "POST" && clarifyAnswer !== null) {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const result = await service.answerClarifyPrompt(decodeURIComponent(clarifyAnswer[1] ?? ""), reviewerId, {
      ...optionalField("answerOptionId", readOptionalString(body.answerOptionId)),
      ...optionalField("answerText", readOptionalString(body.answerText)),
      ...optionalField("response", readOptionalString(body.response))
    });
    writeJson(response, 200, result);
    return true;
  }
  const clarifyCancel = url.pathname.match(CLARIFY_CANCEL_PATH);
  if (method === "POST" && clarifyCancel !== null) {
    writeJson(
      response,
      200,
      service.cancelClarifyPrompt(decodeURIComponent(clarifyCancel[1] ?? ""), reviewerId)
    );
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/inbox") {
    writeJson(response, 200, {
      items: publicInboxList(
        service.listInbox({
          ...(readQueryEnum(url.searchParams.get("category")) !== undefined
            ? { category: readQueryEnum(url.searchParams.get("category")) as InboxCategory }
            : {}),
          ...(url.searchParams.get("status") !== null
            ? { status: url.searchParams.get("status") as InboxStatus }
            : {}),
          userId
        })
      )
    });
    return true;
  }
  const inboxItem = url.pathname.match(INBOX_ITEM_PATH);
  if (method === "GET" && inboxItem !== null) {
    const item = service.showInboxItem(decodeURIComponent(inboxItem[1] ?? ""));
    if (item === null) {
      writeJson(response, 404, { error: "inbox_not_found" });
      return true;
    }
    writeJson(response, 200, { item });
    return true;
  }
  const inboxDone = url.pathname.match(INBOX_DONE_PATH);
  if (method === "POST" && inboxDone !== null) {
    writeJson(response, 200, { item: service.markInboxDone(decodeURIComponent(inboxDone[1] ?? ""), reviewerId) });
    return true;
  }
  const inboxDismiss = url.pathname.match(INBOX_DISMISS_PATH);
  if (method === "POST" && inboxDismiss !== null) {
    writeJson(response, 200, { item: service.markInboxDismissed(decodeURIComponent(inboxDismiss[1] ?? "")) });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/next") {
    const sessionId = url.searchParams.get("sessionId");
    writeJson(response, 200, {
      items: service.listNextActions(sessionId !== null && sessionId.length > 0 ? { sessionId } : {})
    });
    return true;
  }
  const nextDone = url.pathname.match(NEXT_DONE_PATH);
  if (method === "POST" && nextDone !== null) {
    writeJson(response, 200, { item: service.markNextActionDone(decodeURIComponent(nextDone[1] ?? "")) });
    return true;
  }
  const nextBlock = url.pathname.match(NEXT_BLOCK_PATH);
  if (method === "POST" && nextBlock !== null) {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    writeJson(response, 200, {
      item: service.blockNextAction(decodeURIComponent(nextBlock[1] ?? ""), readString(body.reason) ?? "blocked")
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/commitments") {
    const sessionId = url.searchParams.get("sessionId");
    writeJson(response, 200, {
      items: service.listCommitments(sessionId !== null && sessionId.length > 0 ? { sessionId } : {})
    });
    return true;
  }
  const commitmentComplete = url.pathname.match(COMMITMENT_COMPLETE_PATH);
  if (method === "POST" && commitmentComplete !== null) {
    writeJson(response, 200, { item: service.completeCommitment(decodeURIComponent(commitmentComplete[1] ?? "")) });
    return true;
  }
  const commitmentBlock = url.pathname.match(COMMITMENT_BLOCK_PATH);
  if (method === "POST" && commitmentBlock !== null) {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    writeJson(response, 200, {
      item: service.blockCommitment(decodeURIComponent(commitmentBlock[1] ?? ""), readString(body.reason) ?? "blocked")
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/schedules") {
    writeJson(response, 200, { schedules: publicScheduleList(service.listSchedules()), status: service.scheduleStatus() });
    return true;
  }
  if (method === "POST" && url.pathname === "/v1/schedules") {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const name = readString(body.name) ?? "scheduled";
    const input = readString(body.input);
    if (input === null) {
      writeJson(response, 400, { error: "input_required" });
      return true;
    }
    const schedule = service.createSchedule({
      agentProfileId: "executor",
      cwd,
      input,
      name,
      ownerUserId: userId,
      providerName: service.currentProvider().name,
      ...optionalField("runAt", readOptionalString(body.at)),
      ...optionalField("every", readOptionalString(body.every)),
      ...optionalField("cron", readOptionalString(body.cron)),
      ...optionalField("sessionId", readOptionalString(body.sessionId))
    });
    writeJson(response, 201, { schedule });
    return true;
  }
  const scheduleShow = url.pathname.match(SCHEDULE_PATH);
  if (method === "GET" && scheduleShow !== null) {
    const schedule = service.showSchedule(decodeURIComponent(scheduleShow[1] ?? ""));
    if (schedule === null) {
      writeJson(response, 404, { error: "schedule_not_found" });
      return true;
    }
    writeJson(response, 200, { schedule });
    return true;
  }
  if (method === "DELETE" && scheduleShow !== null) {
    writeJson(response, 200, { schedule: service.archiveSchedule(decodeURIComponent(scheduleShow[1] ?? "")) });
    return true;
  }
  if (method === "POST" && url.pathname.match(SCHEDULE_PAUSE_PATH)) {
    writeJson(response, 200, {
      schedule: service.pauseSchedule(decodeURIComponent(url.pathname.match(SCHEDULE_PAUSE_PATH)?.[1] ?? ""))
    });
    return true;
  }
  if (method === "POST" && url.pathname.match(SCHEDULE_RESUME_PATH)) {
    writeJson(response, 200, {
      schedule: service.resumeSchedule(decodeURIComponent(url.pathname.match(SCHEDULE_RESUME_PATH)?.[1] ?? ""))
    });
    return true;
  }
  if (method === "POST" && url.pathname.match(SCHEDULE_RUN_PATH)) {
    writeJson(response, 200, {
      run: service.runScheduleNow(decodeURIComponent(url.pathname.match(SCHEDULE_RUN_PATH)?.[1] ?? ""))
    });
    return true;
  }
  if (method === "GET" && url.pathname.match(SCHEDULE_RUNS_PATH)) {
    writeJson(response, 200, {
      runs: service.listScheduleRuns(decodeURIComponent(url.pathname.match(SCHEDULE_RUNS_PATH)?.[1] ?? ""))
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/memory") {
    writeJson(response, 200, {
      memories: publicMemoryList(service.listMemories()),
      status: service.getLongTermMemoryStatus(cwd)
    });
    return true;
  }
  if (method === "POST" && url.pathname === "/v1/memory") {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const content = readString(body.content);
    const scope = body.scope === "profile" ? "profile" : "project";
    if (content === null) {
      writeJson(response, 400, { error: "content_required" });
      return true;
    }
    writeJson(response, 201, {
      memory: service.addMemory({
        content,
        cwd,
        profileId: "default",
        reviewerId,
        scope,
        userId
      })
    });
    return true;
  }
  if (method === "POST" && url.pathname === "/v1/memory/enabled") {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    writeJson(response, 200, service.setLongTermMemoryEnabled(cwd, body.enabled !== false));
    return true;
  }
  const memoryItem = url.pathname.match(MEMORY_ITEM_PATH);
  if (method === "GET" && memoryItem !== null) {
    const why = service.explainMemoryRecall(url.searchParams.get("taskId") ?? "", decodeURIComponent(memoryItem[1] ?? ""));
    writeJson(response, 200, why);
    return true;
  }
  const memoryForget = url.pathname.match(MEMORY_FORGET_PATH);
  if (method === "POST" && memoryForget !== null) {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    writeJson(response, 200, {
      memory: service.forgetMemory(
        decodeURIComponent(memoryForget[1] ?? ""),
        reviewerId,
        readString(body.note) ?? "forgotten from web"
      )
    });
    return true;
  }
  if (method === "POST" && url.pathname === "/v1/memory/conflict") {
    const body = await requireBody(request, response);
    if (body === null) {
      return true;
    }
    const keepMemoryId = readString(body.keepMemoryId);
    const archiveMemoryId = readString(body.archiveMemoryId);
    if (keepMemoryId === null || archiveMemoryId === null) {
      writeJson(response, 400, { error: "memory_ids_required" });
      return true;
    }
    writeJson(response, 200, service.resolveMemoryConflict({ archiveMemoryId, keepMemoryId, reviewerId }));
    return true;
  }

  if (method === "GET" && url.pathname === "/v1/experiences") {
    writeJson(response, 200, { experiences: publicExperienceList(service.listExperiences()) });
    return true;
  }
  if (method === "GET" && url.pathname === "/v1/skills") {
    writeJson(response, 200, { skills: service.listSkills() });
    return true;
  }
  if (method === "POST" && url.pathname.match(SKILL_ENABLE_PATH)) {
    writeJson(response, 200, {
      skill: service.enableSkill(decodeURIComponent(url.pathname.match(SKILL_ENABLE_PATH)?.[1] ?? ""))
    });
    return true;
  }
  if (method === "POST" && url.pathname.match(SKILL_DISABLE_PATH)) {
    writeJson(response, 200, {
      skill: service.disableSkill(decodeURIComponent(url.pathname.match(SKILL_DISABLE_PATH)?.[1] ?? ""))
    });
    return true;
  }

  return false;
}

async function handleSessionModel(
  service: AgentApplicationService,
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string
): Promise<boolean> {
  if (service.findSession(sessionId) === null) {
    writeJson(response, 404, { error: "session_not_found" });
    return true;
  }
  const body = await requireBody(request, response);
  if (body === null) {
    return true;
  }
  const selection = body.selection;
  if (selection === null) {
    const result = await service.clearSessionModelSelection(sessionId);
    writeJson(response, 200, {
      modelSelection: result.view.session.modelSelection,
      session: result.session,
      view: publicModelSelectionView(result.view)
    });
    return true;
  }
  if (typeof selection !== "string" || selection.trim().length === 0) {
    writeJson(response, 400, { error: "selection_required" });
    return true;
  }
  const persist = body.persist === "user" || body.persist === "workspace" ? body.persist : undefined;
  if (persist !== undefined) {
    await service.switchProvider({ persist, selection, sessionId });
  }
  const result = await service.setSessionModelSelection({ selection, sessionId });
  writeJson(response, 200, {
    modelSelection: result.view.session.modelSelection,
    session: result.session,
    view: publicModelSelectionView(result.view)
  });
  return true;
}

function writeSessionDetail(
  service: AgentApplicationService,
  response: ServerResponse,
  sessionId: string
): boolean {
  const session = service.findSession(sessionId);
  if (session === null) {
    writeJson(response, 404, { error: "session_not_found" });
    return true;
  }
  const detail = service.showSession(sessionId);
  writeJson(response, 200, {
    detail,
    index: service.listSessionIndex().find((entry) => entry.sessionId === sessionId) ?? null,
    modelSelection: service.modelSelectionView(sessionId).session.modelSelection,
    session
  });
  return true;
}

function startTaskEventStream(
  service: AgentApplicationService,
  turns: SessionTurnManager,
  response: ServerResponse,
  request: IncomingMessage,
  taskId: string
): boolean {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8"
  });
  const send = (event: string, payload: unknown): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  for (const output of service.outputTask(taskId)) {
    send("output", output);
  }
  for (const trace of service.traceTask(taskId)) {
    send("trace", trace);
  }
  const current = service.listTasks().find((task) => task.taskId === taskId);
  if (
    current !== undefined &&
    (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled")
  ) {
    send("done", { status: current.status, taskId });
  }
  const unsubscribeOutput = service.subscribeToTaskOutput(taskId, (event) => {
    send("output", event);
  });
  const unsubscribeTrace = service.subscribeToTaskTrace(taskId, (event) => {
    send("trace", event);
  });
  const turn = turns.get(taskId);
  if (turn !== undefined) {
    void turn.done.then(
      (result) => {
        send("done", { status: result.task.status, taskId });
      },
      () => {
        send("done", { status: "failed", taskId });
      }
    );
  }
  const close = (): void => {
    unsubscribeOutput();
    unsubscribeTrace();
  };
  request.on("close", close);
  return true;
}

async function requireBody(
  request: IncomingMessage,
  response: ServerResponse
): Promise<Record<string, unknown> | null> {
  const body = await readJsonBody(request);
  if (body === null) {
    writeJson(response, 400, { error: "invalid_json" });
    return null;
  }
  return body;
}

function optionalProviderWrite(body: Record<string, unknown>): {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
} {
  const apiKey = readOptionalString(body.apiKey);
  const baseUrl = readOptionalString(body.baseUrl);
  const model = readOptionalString(body.model);
  const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  };
}

function sanitizeProvider(provider: ReturnType<AgentApplicationService["currentProvider"]>): JsonObject {
  return {
    configured: provider.configured !== false,
    displayName: provider.displayName,
    model: provider.model,
    name: provider.name
  };
}

function parseAllowScope(value: unknown): ApprovalAllowScope | undefined {
  if (value === "once" || value === "session" || value === "always") {
    return value;
  }
  return undefined;
}

function readQueryEnum(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value;
}
