import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileText,
  Plus,
  RotateCcw,
  Send,
  Square,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { profileService } from "@/services";
import { useAgentStore } from "@/stores/agentStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { cn } from "@/lib/utils";
import type { AgentSession, AgentStatus, TerminalProfile } from "@/types";

const ATTENTION_STATUSES: AgentStatus[] = ["waiting", "approval", "failed"];

export function AgentPanel() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [terminalProfileId, setTerminalProfileId] = useState("");
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfile[]>(
    [],
  );
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [replyBySession, setReplyBySession] = useState<Record<string, string>>(
    {},
  );
  const activeProjectId = useTerminalStore((state) => state.activeProjectId);
  const profiles = useAgentStore((state) => state.profiles);
  const sessions = useAgentStore((state) => state.sessions);
  const eventsBySessionId = useAgentStore((state) => state.eventsBySessionId);
  const load = useAgentStore((state) => state.load);
  const refreshSessions = useAgentStore((state) => state.refreshSessions);
  const createProfile = useAgentStore((state) => state.createProfile);
  const start = useAgentStore((state) => state.start);
  const stop = useAgentStore((state) => state.stop);
  const restart = useAgentStore((state) => state.restart);
  const respond = useAgentStore((state) => state.respond);
  const interrupt = useAgentStore((state) => state.interrupt);
  const loadEvents = useAgentStore((state) => state.loadEvents);
  const previousStatuses = useRef<Record<string, AgentStatus>>({});

  const projectProfiles = useMemo(
    () => profiles.filter((profile) => profile.projectId === activeProjectId),
    [activeProjectId, profiles],
  );
  const projectSessions = useMemo(
    () => sessions.filter((session) => session.projectId === activeProjectId),
    [activeProjectId, sessions],
  );
  const attentionCount = sessions.filter((session) =>
    ATTENTION_STATUSES.includes(session.status),
  ).length;

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void refreshSessions(), 1_500);
    return () => window.clearInterval(timer);
  }, [load, refreshSessions]);

  useEffect(() => {
    if (!activeProjectId) {
      setTerminalProfiles([]);
      return;
    }
    void profileService.list(activeProjectId).then((items) => {
      setTerminalProfiles(items);
      setTerminalProfileId((current) =>
        items.some((profile) => profile.id === current)
          ? current
          : (items.find((profile) => profile.isDefault)?.id ?? items[0]?.id ?? ""),
      );
    });
  }, [activeProjectId]);

  useEffect(() => {
    for (const session of sessions) {
      const previous = previousStatuses.current[session.id];
      if (
        previous &&
        previous !== session.status &&
        ["waiting", "approval", "completed", "failed"].includes(session.status)
      ) {
        notifyAgent(session, t);
      }
      previousStatuses.current[session.id] = session.status;
    }
  }, [sessions, t]);

  useEffect(() => {
    if (!selectedLogId) return;
    void loadEvents(selectedLogId);
    const timer = window.setInterval(
      () => void loadEvents(selectedLogId),
      1_500,
    );
    return () => window.clearInterval(timer);
  }, [loadEvents, selectedLogId]);

  async function handleCreate() {
    if (!activeProjectId || !name.trim() || !terminalProfileId) return;
    const profile = await createProfile({
      name: name.trim(),
      projectId: activeProjectId,
      terminalProfileId,
      command: command.trim(),
      waitingPatterns: ["waiting for input", "please reply"],
      approvalPatterns: ["approval required", "allow this command"],
    });
    setCreating(false);
    setName("");
    setCommand("");
    await requestNotificationPermission();
    await start(profile.id);
  }

  return (
    <section className="border-t border-border">
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 px-3 text-xs font-semibold text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Bot className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">{t("Agents")}</span>
        {attentionCount > 0 ? (
          <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] text-warning">
            {attentionCount}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="app-scrollbar max-h-[42vh] space-y-2 overflow-y-auto px-2 pb-2">
          {projectSessions.map((session) => (
            <AgentSessionCard
              key={session.id}
              session={session}
              profileName={
                profiles.find(
                  (profile) => profile.id === session.agentProfileId,
                )?.name ?? t("Agent")
              }
              reply={replyBySession[session.id] ?? ""}
              onReplyChange={(value) =>
                setReplyBySession((current) => ({
                  ...current,
                  [session.id]: value,
                }))
              }
              onReply={async () => {
                const value = replyBySession[session.id]?.trim();
                if (!value) return;
                await respond(session.id, value);
                setReplyBySession((current) => ({
                  ...current,
                  [session.id]: "",
                }));
              }}
              onInterrupt={() => void interrupt(session.id)}
              onStop={() => void stop(session.id)}
              onRestart={() => void restart(session.id)}
              onLogs={() =>
                setSelectedLogId((current) =>
                  current === session.id ? null : session.id,
                )
              }
            />
          ))}

          {selectedLogId ? (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-border bg-background/70 p-2 font-mono text-[10px]">
              {(eventsBySessionId[selectedLogId] ?? []).map((event) => (
                <div key={event.id} className="break-words text-muted-foreground">
                  <span className="mr-1 text-primary">{event.kind}</span>
                  {event.message}
                </div>
              ))}
            </div>
          ) : null}

          {creating ? (
            <div className="space-y-2 rounded-md border border-border bg-background/60 p-2">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("Agent name")}
                className="h-7 text-xs"
              />
              <select
                value={terminalProfileId}
                onChange={(event) => setTerminalProfileId(event.target.value)}
                className="h-7 w-full rounded border border-border bg-background px-2 text-xs"
              >
                {terminalProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <Input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder={t("Agent command (for example: codex)")}
                className="h-7 text-xs"
              />
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  disabled={!name.trim() || !terminalProfileId}
                  onClick={() => void handleCreate()}
                >
                  {t("Create and start")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setCreating(false)}
                >
                  {t("Cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 flex-1 justify-start text-xs"
                disabled={!activeProjectId || terminalProfiles.length === 0}
                onClick={() => setCreating(true)}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("New agent")}
              </Button>
              {projectProfiles.map((profile) => (
                <Button
                  key={profile.id}
                  variant="ghost"
                  size="sm"
                  className="h-7 max-w-24 text-xs"
                  title={profile.name}
                  onClick={() => void start(profile.id)}
                >
                  <Zap className="mr-1 h-3 w-3" />
                  <span className="truncate">{profile.name}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function AgentSessionCard({
  session,
  profileName,
  reply,
  onReplyChange,
  onReply,
  onInterrupt,
  onStop,
  onRestart,
  onLogs,
}: {
  session: AgentSession;
  profileName: string;
  reply: string;
  onReplyChange: (value: string) => void;
  onReply: () => void;
  onInterrupt: () => void;
  onStop: () => void;
  onRestart: () => void;
  onLogs: () => void;
}) {
  const needsInput = session.status === "waiting" || session.status === "approval";
  return (
    <div className="rounded-md border border-border bg-background/50 p-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            statusColor(session.status),
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {profileName}
        </span>
        <span className="text-[10px] uppercase text-muted-foreground">
          {session.status}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {session.tokenUsage.totalTokens.toLocaleString()} tokens
        {session.exitReason ? ` · ${session.exitReason}` : ""}
      </div>
      {needsInput ? (
        <div className="mt-2 flex gap-1">
          <Input
            value={reply}
            onChange={(event) => onReplyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onReply();
            }}
            placeholder={session.status === "approval" ? "yes / no" : "Reply"}
            className="h-7 text-xs"
          />
          <Button size="icon" className="h-7 w-7" onClick={onReply}>
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}
      <div className="mt-1 flex justify-end gap-0.5">
        <IconButton label="Logs" onClick={onLogs}>
          <FileText />
        </IconButton>
        <IconButton label="Ctrl+C" onClick={onInterrupt}>
          <CircleStop />
        </IconButton>
        <IconButton label="Restart" onClick={onRestart}>
          <RotateCcw />
        </IconButton>
        <IconButton label="Stop" onClick={onStop}>
          <Square />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactElement;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:h-3.5 [&>svg]:w-3.5"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function statusColor(status: AgentStatus) {
  if (status === "approval") return "bg-warning";
  if (status === "waiting") return "bg-primary";
  if (status === "failed") return "bg-destructive";
  if (status === "completed") return "bg-ok";
  if (status === "running" || status === "starting") return "bg-ok animate-pulse";
  return "bg-muted-foreground";
}

async function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function notifyAgent(
  session: AgentSession,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  new Notification(t("Agent status changed"), {
    body: `${session.status}${session.exitReason ? `: ${session.exitReason}` : ""}`,
  });
}
