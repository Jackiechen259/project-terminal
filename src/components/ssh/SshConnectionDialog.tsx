import { useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sshService, type SshConnectionInput } from "@/services";
import { useSshStore } from "@/stores/sshStore";
import type { SshAuthenticationType, SshConnection } from "@/types";
import { useTranslation } from "@/i18n";

type Draft = {
  id?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authenticationType: SshAuthenticationType;
  identityFile: string;
  useSshAgent: boolean;
  jumpHost: string;
  jumpPort: string;
  jumpUsername: string;
  connectTimeoutSeconds: string;
  serverAliveIntervalSeconds: string;
  serverAliveCountMax: string;
  strictHostKeyChecking: boolean;
  knownHostsFile: string;
  extraArgs: string;
};

function emptyDraft(): Draft {
  return {
    name: "",
    host: "",
    port: "22",
    username: "",
    authenticationType: "agent",
    identityFile: "",
    useSshAgent: true,
    jumpHost: "",
    jumpPort: "22",
    jumpUsername: "",
    connectTimeoutSeconds: "15",
    serverAliveIntervalSeconds: "30",
    serverAliveCountMax: "3",
    strictHostKeyChecking: true,
    knownHostsFile: "",
    extraArgs: "",
  };
}

function draftFrom(connection: SshConnection): Draft {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    username: connection.username,
    authenticationType: connection.authenticationType,
    identityFile: connection.identityFile ?? "",
    useSshAgent: connection.useSshAgent,
    jumpHost: connection.jumpHost?.host ?? "",
    jumpPort: String(connection.jumpHost?.port ?? 22),
    jumpUsername: connection.jumpHost?.username ?? "",
    connectTimeoutSeconds: String(connection.connectTimeoutSeconds),
    serverAliveIntervalSeconds: String(connection.serverAliveIntervalSeconds),
    serverAliveCountMax: String(connection.serverAliveCountMax),
    strictHostKeyChecking: connection.strictHostKeyChecking,
    knownHostsFile: connection.knownHostsFile ?? "",
    extraArgs: (connection.extraArgs ?? []).join("\n"),
  };
}

function positiveNumber(
  value: string,
  field: string,
  maximum = 65535,
  t?: (source: string, params?: Record<string, string | number>) => string,
): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(
      (t ?? ((s: string) => s))(
        "{field} must be a whole number between 1 and {maximum}.",
        { field, maximum },
      ),
    );
  }
  return number;
}

function toInput(
  draft: Draft,
  t: (source: string, params?: Record<string, string | number>) => string,
): SshConnectionInput {
  const jumpHost = draft.jumpHost.trim()
    ? {
        host: draft.jumpHost.trim(),
        port: positiveNumber(draft.jumpPort, t("Jump port"), 65535, t),
        username: draft.jumpUsername.trim() || undefined,
      }
    : undefined;
  return {
    id: draft.id,
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: positiveNumber(draft.port, t("Port"), 65535, t),
    username: draft.username.trim(),
    authenticationType: draft.authenticationType,
    identityFile: draft.identityFile.trim() || undefined,
    useSshAgent: draft.useSshAgent,
    jumpHost,
    connectTimeoutSeconds: positiveNumber(
      draft.connectTimeoutSeconds,
      t("Connect timeout (s)"),
      600,
      t,
    ),
    serverAliveIntervalSeconds: positiveNumber(
      draft.serverAliveIntervalSeconds,
      t("Keepalive interval (s)"),
      3600,
      t,
    ),
    serverAliveCountMax: positiveNumber(
      draft.serverAliveCountMax,
      t("Keepalive count"),
      100,
      t,
    ),
    strictHostKeyChecking: draft.strictHostKeyChecking,
    knownHostsFile: draft.knownHostsFile.trim() || undefined,
    extraArgs: draft.extraArgs
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

/** Manage reusable, non-secret SSH connection settings. */
export function SshConnectionDialog({
  trigger,
  onClosed,
  openState: controlledOpen,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  onClosed?: () => void;
  openState?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connections = useSshStore((state) => state.connections);
  const clientPath = useSshStore((state) => state.sshClientPath);
  const storeError = useSshStore((state) => state.error);
  const loadConnections = useSshStore((state) => state.loadConnections);
  const detectSshClient = useSshStore((state) => state.detectSshClient);
  const createConnection = useSshStore((state) => state.createConnection);
  const updateConnection = useSshStore((state) => state.updateConnection);
  const deleteConnection = useSshStore((state) => state.deleteConnection);

  useEffect(() => {
    if (!open) return;
    void loadConnections();
    void detectSshClient();
    setDraft(null);
    setError(null);
    setResult(null);
  }, [open, loadConnections, detectSshClient]);

  const selected = useMemo(
    () => connections.find((connection) => connection.id === draft?.id) ?? null,
    [connections, draft?.id],
  );

  function change<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const input = toInput(draft, t);
      if (input.authenticationType !== "system-config" && !input.username) {
        throw new Error(
          t("Username is required unless you use a system SSH config alias."),
        );
      }
      if (input.authenticationType === "key" && !input.identityFile) {
        throw new Error(
          t("Key authentication requires an identity file path."),
        );
      }
      const saved = draft.id
        ? await updateConnection(input)
        : await createConnection(input);
      setDraft(draftFrom(saved));
      setResult(t("Connection saved."));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("Unable to save SSH connection."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await sshService.test(selected.id));
    } catch (cause) {
      setError(
        (cause as { message?: string }).message ??
          t("SSH connection test failed."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection() {
    if (
      !selected ||
      !window.confirm(
        t('Remove SSH connection "{name}"?', { name: selected.name }),
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await deleteConnection(selected.id);
      setDraft(null);
      setResult(t("Connection removed."));
    } catch (cause) {
      setError(
        (cause as { message?: string }).message ??
          t("Unable to remove SSH connection."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) onClosed?.();
      }}
    >
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{t("SSH connections")}</DialogTitle>
          <DialogDescription>
            {t(
              "Reusable connection settings. Passwords and private-key contents are never stored.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="truncate">
            {clientPath === undefined
              ? t("Detecting OpenSSH client…")
              : clientPath
                ? t("OpenSSH: {path}", { path: clientPath })
                : t(
                    "OpenSSH client was not found. Install Windows OpenSSH Client to connect.",
                  )}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t("Detect SSH client again")}
            onClick={() => void detectSshClient()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-[190px_1fr]">
          <div className="flex max-h-[440px] flex-col gap-1 overflow-y-auto rounded-md border border-border p-1">
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setDraft(emptyDraft());
                setError(null);
                setResult(null);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t("New connection")}
            </Button>
            {connections.map((connection) => (
              <Button
                key={connection.id}
                variant={connection.id === draft?.id ? "secondary" : "ghost"}
                className="justify-start"
                onClick={() => {
                  setDraft(draftFrom(connection));
                  setError(null);
                  setResult(null);
                }}
              >
                <Server className="mr-2 h-4 w-4 shrink-0" />
                <span className="truncate">{connection.name}</span>
              </Button>
            ))}
          </div>

          {draft ? (
            <ConnectionForm draft={draft} busy={busy} onChange={change} />
          ) : (
            <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
              {t("Create or select an SSH connection.")}
            </div>
          )}
        </div>

        {storeError ? <Message error={storeError.message} /> : null}
        {error ? <Message error={error} /> : null}
        {result ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-ok">
            {result}
          </div>
        ) : null}

        <DialogFooter>
          {selected ? (
            <Button
              variant="destructive"
              onClick={() => void removeConnection()}
              disabled={busy}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("Remove")}
            </Button>
          ) : null}
          <div className="flex-1" />
          {selected ? (
            <Button
              variant="secondary"
              onClick={() => void testConnection()}
              disabled={busy || !clientPath}
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              {t("Test")}
            </Button>
          ) : null}
          {draft ? (
            <Button onClick={() => void save()} disabled={busy || !clientPath}>
              {busy ? t("Working…") : t("Save connection")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Message({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {error}
    </div>
  );
}

function ConnectionForm({
  draft,
  busy,
  onChange,
}: {
  draft: Draft;
  busy: boolean;
  onChange: <Key extends keyof Draft>(key: Key, value: Draft[Key]) => void;
}) {
  const { t } = useTranslation();
  const field = <Key extends keyof Draft>(
    key: Key,
    label: string,
    options?: { type?: string; placeholder?: string; disabled?: boolean },
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`ssh-${key}`}>{label}</Label>
      <Input
        id={`ssh-${key}`}
        type={options?.type}
        value={String(draft[key])}
        placeholder={options?.placeholder}
        disabled={busy || options?.disabled}
        onChange={(event) => onChange(key, event.target.value as Draft[Key])}
      />
    </div>
  );
  const isSystemConfig = draft.authenticationType === "system-config";
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {field("name", t("Connection name"), {
          placeholder: t("GPU server"),
        })}
        {field("host", isSystemConfig ? t("SSH config alias") : t("Host"), {
          placeholder: isSystemConfig ? "gpu-prod" : "server.example.com",
        })}
        {field("port", t("Port"), { type: "number" })}
        {field("username", t("Username"), {
          placeholder: isSystemConfig
            ? t("Optional; read from SSH config")
            : "developer",
          disabled: isSystemConfig,
        })}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{t("Authentication")}</Label>
        <Select
          value={draft.authenticationType}
          onValueChange={(value) =>
            onChange("authenticationType", value as SshAuthenticationType)
          }
          disabled={busy}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="agent">
              {t("SSH agent (recommended)")}
            </SelectItem>
            <SelectItem value="key">{t("Private key file")}</SelectItem>
            <SelectItem value="password">
              {t("Password in terminal")}
            </SelectItem>
            <SelectItem value="keyboard-interactive">
              {t("Keyboard interactive")}
            </SelectItem>
            <SelectItem value="system-config">
              {t("System SSH config")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {draft.authenticationType === "key"
        ? field("identityFile", t("Identity file path"), {
            placeholder: "C:\\Users\\you\\.ssh\\id_ed25519",
          })
        : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.useSshAgent}
          disabled={busy}
          onChange={(event) => onChange("useSshAgent", event.target.checked)}
        />
        {t("Use the system SSH agent")}
      </label>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t("Connection options")}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {field("connectTimeoutSeconds", t("Connect timeout (s)"), {
            type: "number",
          })}
          {field("serverAliveIntervalSeconds", t("Keepalive interval (s)"), {
            type: "number",
          })}
          {field("serverAliveCountMax", t("Keepalive count"), {
            type: "number",
          })}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {field("jumpHost", t("Jump host"), {
            placeholder: "gateway.example.com",
          })}
          {field("jumpPort", t("Jump port"), { type: "number" })}
          {field("jumpUsername", t("Jump username"), {
            placeholder: t("Optional"),
          })}
          {field("knownHostsFile", t("Known hosts file"), {
            placeholder: t("Use system default"),
          })}
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor="ssh-extraArgs">
            {t("Extra OpenSSH arguments (one argv item per line)")}
          </Label>
          <textarea
            id="ssh-extraArgs"
            className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={draft.extraArgs}
            disabled={busy}
            onChange={(event) => onChange("extraArgs", event.target.value)}
            placeholder="-v"
          />
        </div>
      </details>
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-warn">
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={draft.strictHostKeyChecking}
            disabled={busy}
            onChange={(event) =>
              onChange("strictHostKeyChecking", event.target.checked)
            }
          />
          <span>
            <strong>{t("Strict host-key checking")}</strong>
            <br />
            {t(
              "Keep enabled to only trust known keys. If you turn it off, OpenSSH still asks before accepting a new key and this app never auto-accepts it; changed keys remain blocked.",
            )}
          </span>
        </label>
      </div>
      {draft.authenticationType === "key" ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          {t(
            "Only the key path is saved. Passphrases are entered directly in the terminal.",
          )}
        </p>
      ) : null}
    </div>
  );
}
