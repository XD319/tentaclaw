import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type ApprovalRecord,
  type BootstrapResponse,
  type ChatMessage,
  type ClarifyPrompt,
  type FileChange,
  type SessionIndexEntry
} from "./api";
import { SLASH_COMMANDS } from "./slash";
import {
  activityTrace,
  dialogMessages,
  formatSessionTime,
  mergeTranscript,
  normalizeChatMessages,
  sessionLabel
} from "./transcript";

type Mode = "agent" | "plan" | "acceptEdits";
type RailTab =
  | "changes"
  | "trace"
  | "inbox"
  | "memory"
  | "schedule"
  | "tasks"
  | "skills"
  | "experience";

interface UiState {
  messages?: unknown[];
}

export function App(): React.ReactElement {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("agent");
  const [activeRun, setActiveRun] = useState<{ sessionId: string; taskId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [rail, setRail] = useState<RailTab>("changes");
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [clarifies, setClarifies] = useState<ClarifyPrompt[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [inbox, setInbox] = useState<Array<{ inboxId: string; title: string; summary?: string }>>([]);
  const [memories, setMemories] = useState<Array<{ memoryId: string; title: string; content?: string }>>([]);
  const [schedules, setSchedules] = useState<Array<{ scheduleId: string; name: string; status?: string }>>([]);
  const [tasks, setTasks] = useState<Array<{ taskId: string; status: string; input?: string }>>([]);
  const [skills, setSkills] = useState<Array<{ id?: string; metadata?: { id?: string; name?: string } }>>([]);
  const [experiences, setExperiences] = useState<Array<{ experienceId: string; title?: string }>>([]);
  const [trace, setTrace] = useState<Array<{ eventType: string; summary: string }>>([]);
  const [query, setQuery] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const visibleMessages = useMemo(() => dialogMessages(messages), [messages]);
  const busy = activeRun !== null && activeRun.sessionId === sessionId;
  const taskId = activeRun !== null && activeRun.sessionId === sessionId ? activeRun.taskId : null;
  sessionIdRef.current = sessionId;

  const loadBootstrap = useCallback(async () => {
    const data = await api<BootstrapResponse>("/v1/bootstrap");
    setBootstrap(data);
    setShowSettings(!data.provider.configured);
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await api<{ sessions: SessionIndexEntry[] }>("/v1/sessions");
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const data = await api<UiState>(`/v1/sessions/${id}/messages`);
    if (sessionIdRef.current !== id) {
      return;
    }
    const next = normalizeChatMessages(data.messages ?? []);
    setMessages((current) => mergeTranscript(next, current));
    setTrace(activityTrace(next));
  }, []);

  const loadTurnState = useCallback(async (id: string | null) => {
    const [approvalData, clarifyData] = await Promise.all([
      api<{ approvals: ApprovalRecord[] }>("/v1/approvals/pending"),
      api<{ prompts: ClarifyPrompt[] }>("/v1/clarify/pending")
    ]);
    setApprovals(approvalData.approvals);
    setClarifies(clarifyData.prompts);
    if (id !== null) {
      const changeData = await api<{ changes: FileChange[] }>(`/v1/sessions/${id}/changes`);
      setChanges(changeData.changes);
    }
  }, []);

  const loadRail = useCallback(async (tab: RailTab) => {
    if (tab === "changes" || tab === "trace") {
      return;
    }
    if (tab === "inbox") {
      const data = await api<{ items: Array<{ inboxId: string; title: string; summary?: string }> }>("/v1/inbox");
      setInbox(data.items ?? []);
      return;
    }
    if (tab === "memory") {
      const data = await api<{ memories: Array<{ memoryId: string; title: string; content?: string }> }>("/v1/memory");
      setMemories(data.memories ?? []);
      return;
    }
    if (tab === "schedule") {
      const data = await api<{ schedules: Array<{ scheduleId: string; name: string; status?: string }> }>("/v1/schedules");
      setSchedules(data.schedules ?? []);
      return;
    }
    if (tab === "tasks") {
      const data = await api<{ tasks: Array<{ taskId: string; status: string; input?: string }> }>("/v1/tasks");
      setTasks(data.tasks ?? []);
      return;
    }
    if (tab === "skills") {
      const data = await api<{ skills: Array<{ id?: string; metadata?: { id?: string; name?: string } }> }>("/v1/skills");
      setSkills(data.skills ?? []);
      return;
    }
    const data = await api<{ experiences: Array<{ experienceId: string; title?: string }> }>("/v1/experiences");
    setExperiences(data.experiences ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadBootstrap();
        const list = await loadSessions();
        if (list[0] !== undefined) {
          setSessionId(list[0].sessionId);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [loadBootstrap, loadSessions]);

  useEffect(() => {
    if (sessionId === null) {
      return;
    }
    setMessages([]);
    setTrace([]);
    setChanges([]);
    void loadMessages(sessionId).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
    void loadTurnState(sessionId).catch(() => undefined);
  }, [loadMessages, loadTurnState, sessionId]);

  useEffect(() => {
    void loadRail(rail).catch(() => undefined);
  }, [loadRail, rail, sessionId]);

  useEffect(() => {
    if (activeRun === null) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      return;
    }
    const run = activeRun;
    const source = new EventSource(`/v1/tasks/${run.taskId}/events`);
    eventSourceRef.current = source;
    source.addEventListener("output", () => {
      if (sessionIdRef.current === run.sessionId) {
        void loadMessages(run.sessionId);
      }
    });
    source.addEventListener("trace", (event) => {
      if (sessionIdRef.current !== run.sessionId) {
        return;
      }
      try {
        const payload = JSON.parse(event.data) as { eventType?: string; summary?: string };
        setTrace((current) => [
          ...current.slice(-80),
          { eventType: payload.eventType ?? "event", summary: payload.summary ?? "" }
        ]);
      } catch {
        /* ignore malformed SSE */
      }
      void loadTurnState(run.sessionId);
    });
    source.addEventListener("done", (event) => {
      try {
        const payload = JSON.parse(event.data) as { status?: string };
        if (
          payload.status === "succeeded" ||
          payload.status === "failed" ||
          payload.status === "cancelled" ||
          payload.status === "timed_out"
        ) {
          setActiveRun(null);
        }
      } catch {
        setActiveRun(null);
      }
      if (sessionIdRef.current === run.sessionId) {
        void loadMessages(run.sessionId);
        void loadTurnState(run.sessionId);
      }
    });
    source.onerror = () => undefined;
    return () => {
      source.close();
    };
  }, [activeRun, loadMessages, loadTurnState]);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return sessions;
    }
    return sessions.filter((session) => sessionLabel(session).toLowerCase().includes(needle) || session.sessionId.toLowerCase().includes(needle));
  }, [query, sessions]);

  const slashHints = draft.startsWith("/")
    ? SLASH_COMMANDS.filter((item) => item.insert.startsWith(draft.trim()) || item.label.toLowerCase().includes(draft.slice(1).toLowerCase()))
    : [];

  async function ensureSession(): Promise<string> {
    if (sessionId !== null) {
      return sessionId;
    }
    const created = await api<{ session: { sessionId: string } }>("/v1/sessions", {
      body: JSON.stringify({ title: "New chat" }),
      method: "POST"
    });
    setSessionId(created.session.sessionId);
    await loadSessions();
    return created.session.sessionId;
  }

  async function newChat(): Promise<void> {
    const created = await api<{ session: { sessionId: string } }>("/v1/sessions", {
      body: JSON.stringify({ title: "New chat" }),
      method: "POST"
    });
    setSessionId(created.session.sessionId);
    setMessages([]);
    setShowSettings(false);
    await loadSessions();
  }

  async function handleSlash(text: string): Promise<boolean> {
    const value = text.trim();
    if (value === "/new" || value === "/clear") {
      await newChat();
      return true;
    }
    if (value === "/sessions") {
      return true;
    }
    if (value.startsWith("/mode ")) {
      const next = value.slice(6).trim();
      if (next === "agent" || next === "plan" || next === "acceptEdits") {
        setMode(next);
      }
      return true;
    }
    if (value === "/stop" && activeRun !== null) {
      await api(`/v1/tasks/${activeRun.taskId}/stop`, { method: "POST" });
      setActiveRun(null);
      return true;
    }
    if (value === "/diff") {
      setRail("changes");
      return true;
    }
    if (value === "/inbox") {
      setRail("inbox");
      return true;
    }
    if (value === "/memory") {
      setRail("memory");
      return true;
    }
    if (value === "/schedule") {
      setRail("schedule");
      return true;
    }
    if (value === "/compact" && sessionId !== null) {
      await api(`/v1/sessions/${sessionId}/compact`, { body: JSON.stringify({}), method: "POST" });
      return true;
    }
    if (value === "/help") {
      setShowSettings(false);
      setMessages((current) => [
        ...current,
        {
          id: `local:help:${Date.now()}`,
          kind: "system",
          text: SLASH_COMMANDS.map((item) => `${item.insert} — ${item.label}`).join("\n")
        }
      ]);
      return true;
    }
    if (value === "/sandbox" || value === "/model") {
      setShowSettings(true);
      return true;
    }
    if (value === "/today") {
      setRail("inbox");
      return true;
    }
    if (value.startsWith("/model ")) {
      const selection = value.slice(7).trim();
      if (sessionId !== null && selection.length > 0) {
        await api(`/v1/sessions/${sessionId}/model`, {
          body: JSON.stringify({ selection }),
          method: "PATCH"
        });
        await loadBootstrap();
      }
      return true;
    }
    return false;
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text.length === 0 || busy) {
      return;
    }
    setDraft("");
    setError(null);
    if (text.startsWith("/")) {
      const handled = await handleSlash(text);
      if (handled) {
        return;
      }
    }
    const id = await ensureSession();
    setMessages((current) => [
      ...current,
      {
        id: `local:${Date.now()}`,
        kind: "user",
        text,
        timestamp: new Date().toISOString()
      }
    ]);
    try {
      const turn = await api<{ taskId: string }>(`/v1/sessions/${id}/turns`, {
        body: JSON.stringify({ input: text, interactionMode: mode }),
        method: "POST"
      });
      setActiveRun({ sessionId: id, taskId: turn.taskId });
      await loadMessages(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setActiveRun(null);
    }
  }

  useEffect(() => {
    const node = transcriptRef.current;
    if (node === null) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [sessionId, visibleMessages.length]);

  useEffect(() => {
    if (activeRun === null) {
      return;
    }
    const run = activeRun;
    const timer = window.setInterval(() => {
      if (sessionIdRef.current === run.sessionId) {
        void loadMessages(run.sessionId);
        void loadTurnState(run.sessionId);
      }
      void api<{ task: { status: string } }>(`/v1/tasks/${run.taskId}`)
        .then((data) => {
          if (["succeeded", "failed", "cancelled", "timed_out"].includes(data.task.status)) {
            setActiveRun(null);
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      window.clearInterval(timer);
    };
  }, [activeRun, loadMessages, loadTurnState]);

  async function resolveApproval(approvalId: string, action: "allow" | "deny", allowScope?: "once" | "session" | "always"): Promise<void> {
    await api(`/v1/approvals/${approvalId}/resolve`, {
      body: JSON.stringify({ action, ...(allowScope !== undefined ? { allowScope } : {}) }),
      method: "POST"
    });
    await loadTurnState(sessionId);
  }

  if (bootstrap === null) {
    return <div className="empty">{error ?? "Loading workspace…"}</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">AutoTalon</span>
        <span className="workspace" title={bootstrap.workspaceRoot}>
          {bootstrap.workspaceRoot}
        </span>
        <span className="spacer" />
        <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
          <option value="agent">agent</option>
          <option value="plan">plan</option>
          <option value="acceptEdits">acceptEdits</option>
        </select>
        <select
          value={bootstrap.models.current?.selection ?? ""}
          onChange={(event) => {
            if (sessionId === null) {
              return;
            }
            void api(`/v1/sessions/${sessionId}/model`, {
              body: JSON.stringify({ selection: event.target.value }),
              method: "PATCH"
            }).then(loadBootstrap);
          }}
        >
          {(bootstrap.models.configuredModels ?? []).map((model) => (
            <option key={model.selection} value={model.selection}>
              {model.displayName} ({model.selection})
            </option>
          ))}
        </select>
        <button className="ghost" type="button" onClick={() => setShowSettings((value) => !value)}>
          Settings
        </button>
      </header>
      <aside className="sidebar">
        <div className="pane-head">
          <button className="primary" type="button" onClick={() => void newChat()}>
            New chat
          </button>
        </div>
        <div className="pane-head">
          <input placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="list">
          {filteredSessions.map((session) => (
            <button
              className={session.sessionId === sessionId ? "session active" : "session"}
              key={session.sessionId}
              type="button"
              onClick={() => setSessionId(session.sessionId)}
            >
              <span className="title">{sessionLabel(session)}</span>
              <span className="meta">{formatSessionTime(session.updatedAt)}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="main">
        {showSettings || !bootstrap.provider.configured ? (
          <SettingsPanel
            bootstrap={bootstrap}
            onSaved={() => void loadBootstrap()}
            onClose={bootstrap.provider.configured ? () => setShowSettings(false) : undefined}
          />
        ) : (
          <>
            <div className="transcript" ref={transcriptRef}>
              {visibleMessages.length === 0 ? (
                <div className="empty">
                  {messages.some((message) => message.kind === "activity")
                    ? "This session has tool traces but no chat turns. Open the Trace tab for the logs."
                    : "Start a task. The agent can edit this workspace under sandbox and approval rules."}
                </div>
              ) : (
                visibleMessages.map((message) => (
                  <article className={`msg ${message.kind}`} key={message.id}>
                    <div className="who">{message.kind === "agent" ? "assistant" : message.kind}</div>
                    <div className="body">{message.text}</div>
                  </article>
                ))
              )}
              {approvals.map((approval) => (
                <div className="card" key={approval.approvalId}>
                  <h4>Approval required · {approval.toolName ?? "tool"}</h4>
                  <p>{approval.summary ?? approval.reason ?? approval.approvalId}</p>
                  <div className="row">
                    <button type="button" onClick={() => void resolveApproval(approval.approvalId, "allow", "once")}>
                      Allow once
                    </button>
                    <button type="button" onClick={() => void resolveApproval(approval.approvalId, "allow", "session")}>
                      Allow session
                    </button>
                    <button type="button" onClick={() => void resolveApproval(approval.approvalId, "allow", "always")}>
                      Allow always
                    </button>
                    <button className="danger" type="button" onClick={() => void resolveApproval(approval.approvalId, "deny")}>
                      Deny
                    </button>
                  </div>
                </div>
              ))}
              {clarifies.map((prompt) => (
                <div className="card" key={prompt.promptId}>
                  <h4>Clarification</h4>
                  <p>{prompt.question ?? prompt.prompt ?? prompt.promptId}</p>
                  <div className="row">
                    {(prompt.options ?? []).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() =>
                          void api(`/v1/clarify/${prompt.promptId}/answer`, {
                            body: JSON.stringify({ answerOptionId: option.id }),
                            method: "POST"
                          }).then(() => void loadTurnState(sessionId))
                        }
                      >
                        {option.label}
                      </button>
                    ))}
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => void api(`/v1/clarify/${prompt.promptId}/cancel`, { method: "POST" })}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
              {error !== null ? <div className="card">{error}</div> : null}
            </div>
            <div className="composer">
              {slashHints.length > 0 ? (
                <div className="hints">
                  {slashHints.slice(0, 8).map((hint) => (
                    <span className="hint" key={hint.insert} onClick={() => setDraft(hint.insert)}>
                      {hint.insert} — {hint.label}
                    </span>
                  ))}
                </div>
              ) : null}
              <textarea
                placeholder="Message AutoTalon. Type / for commands."
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-foot">
                <span className="meta">
                  {busy ? "Running…" : bootstrap.provider.configured ? bootstrap.provider.displayName : "Configure a provider"}
                </span>
                <div className="row">
                  {busy && taskId !== null ? (
                    <button className="danger" type="button" onClick={() => void handleSlash("/stop")}>
                      Stop
                    </button>
                  ) : null}
                  <button className="primary" disabled={busy} type="button" onClick={() => void send()}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
      <aside className="rail">
        <div className="tabs">
          {(
            [
              ["changes", "Changes"],
              ["trace", "Trace"],
              ["inbox", "Inbox"],
              ["memory", "Memory"],
              ["schedule", "Schedule"],
              ["tasks", "Tasks"],
              ["skills", "Skills"],
              ["experience", "Experience"]
            ] as Array<[RailTab, string]>
          ).map(([id, label]) => (
            <button className={rail === id ? "active" : ""} key={id} type="button" onClick={() => setRail(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="rail-body">
          {rail === "changes" ? <ChangeList changes={changes} /> : null}
          {rail === "trace" ? (
            trace.length === 0 ? (
              <div className="empty">No trace yet.</div>
            ) : (
              trace.map((event, index) => (
                <div className="card" key={`${event.eventType}-${index}`}>
                  <strong>{event.eventType}</strong>
                  <div>{event.summary}</div>
                </div>
              ))
            )
          ) : null}
          {rail === "inbox" ? (
            inbox.length === 0 ? (
              <div className="empty">Inbox is empty.</div>
            ) : (
              inbox.map((item) => (
                <div className="card" key={item.inboxId}>
                  <strong>{item.title}</strong>
                  <div>{item.summary}</div>
                  <div className="row">
                    <button type="button" onClick={() => void api(`/v1/inbox/${item.inboxId}/done`, { method: "POST" }).then(() => loadRail("inbox"))}>
                      Done
                    </button>
                    <button className="ghost" type="button" onClick={() => void api(`/v1/inbox/${item.inboxId}/dismiss`, { method: "POST" }).then(() => loadRail("inbox"))}>
                      Dismiss
                    </button>
                  </div>
                </div>
              ))
            )
          ) : null}
          {rail === "memory" ? (
            memories.length === 0 ? (
              <div className="empty">No memories.</div>
            ) : (
              memories.map((memory) => (
                <div className="card" key={memory.memoryId}>
                  <strong>{memory.title}</strong>
                  <div>{memory.content}</div>
                </div>
              ))
            )
          ) : null}
          {rail === "schedule" ? (
            schedules.length === 0 ? (
              <div className="empty">No schedules.</div>
            ) : (
              schedules.map((schedule) => (
                <div className="card" key={schedule.scheduleId}>
                  <strong>{schedule.name}</strong>
                  <div>{schedule.status}</div>
                </div>
              ))
            )
          ) : null}
          {rail === "tasks" ? (
            tasks.map((task) => (
              <div className="card" key={task.taskId}>
                <strong>{task.status}</strong>
                <div>{task.input ?? task.taskId}</div>
              </div>
            ))
          ) : null}
          {rail === "skills" ? (
            skills.map((skill, index) => (
              <div className="card" key={skill.metadata?.id ?? skill.id ?? String(index)}>
                {skill.metadata?.name ?? skill.metadata?.id ?? skill.id ?? "skill"}
              </div>
            ))
          ) : null}
          {rail === "experience" ? (
            experiences.map((experience) => (
              <div className="card" key={experience.experienceId}>
                {experience.title ?? experience.experienceId}
              </div>
            ))
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function ChangeList({ changes }: { changes: FileChange[] }): React.ReactElement {
  if (changes.length === 0) {
    return <div className="empty">No file changes in this session.</div>;
  }
  return (
    <>
      {changes.map((change) => {
        const path = change.content?.path ?? change.uri ?? change.artifactId;
        const diff = change.content?.unifiedDiff ?? "";
        return (
          <div className="card" key={change.artifactId}>
            <strong>{path}</strong>
            <div>{change.content?.operation}</div>
            <div className="diff">
              {diff.split("\n").slice(0, 40).map((line, index) => (
                <div className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""} key={`${change.artifactId}-${index}`}>
                  {line}
                </div>
              ))}
            </div>
            <button
              className="ghost"
              type="button"
              onClick={() => void api(`/v1/artifacts/${change.artifactId}/rollback`, { method: "POST" })}
            >
              Rollback
            </button>
          </div>
        );
      })}
    </>
  );
}

function SettingsPanel({
  bootstrap,
  onClose,
  onSaved
}: {
  bootstrap: BootstrapResponse;
  onClose?: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const [name, setName] = useState(bootstrap.provider.configured ? bootstrap.provider.name : "mock");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState(bootstrap.provider.model ?? "");
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    await api("/v1/providers/setup", {
      body: JSON.stringify({
        name,
        ...(apiKey.length > 0 ? { apiKey } : {}),
        ...(baseUrl.length > 0 ? { baseUrl } : {}),
        ...(model.length > 0 ? { model } : {})
      }),
      method: "POST"
    });
    setMessage("Provider saved.");
    onSaved();
  }

  return (
    <section className="settings">
      <h2>Provider setup</h2>
      {onClose !== undefined ? (
        <p>
          <button className="ghost" type="button" onClick={onClose}>
            Back to chat
          </button>
        </p>
      ) : null}
      <p className={bootstrap.provider.configured ? "status-ok" : "status-warn"}>
        {bootstrap.provider.configured
          ? `Active: ${bootstrap.provider.displayName} (${bootstrap.provider.model ?? "no model"})`
          : "No provider configured. Choose Mock to try without an API key."}
      </p>
      <label className="field">
        <span>Provider</span>
        <select value={name} onChange={(event) => setName(event.target.value)}>
          {bootstrap.catalog.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
      {name !== "mock" ? (
        <>
          <label className="field">
            <span>API key</span>
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" />
          </label>
          <label className="field">
            <span>Base URL (for openai-compatible)</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
        </>
      ) : null}
      <div className="row">
        <button className="primary" type="button" onClick={() => void save()}>
          Save and use
        </button>
      </div>
      {message !== null ? <p>{message}</p> : null}
      <p className="meta">Workspace: {bootstrap.workspaceRoot}</p>
    </section>
  );
}
