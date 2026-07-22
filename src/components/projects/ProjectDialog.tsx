import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";

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
import { useProjectStore } from "@/stores/projectStore";
import { useSshStore } from "@/stores/sshStore";
import { usePlatformStore } from "@/stores/platformStore";
import { environmentService, type ProjectInput } from "@/services";
import { SshConnectionDialog } from "@/components/ssh/SshConnectionDialog";
import { RemoteFolderPicker } from "@/components/ssh/RemoteFolderPicker";

type ProjectType = "local" | "ssh" | "wsl";

/**
 * Add a local folder, a WSL distribution, or an SSH remote project. SSH
 * connections are reusable: projects store only the selected connection id and
 * their remote path. WSL projects store the distribution name and an optional
 * Linux working directory; the distribution list is detected from the host's
 * `wsl.exe` when the dialog opens.
 */
export function ProjectDialog({ trigger }: { trigger: React.ReactNode }) {
  const [openState, setOpenState] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<ProjectType>("local");
  const [localPath, setLocalPath] = useState("");
  const [sshConnectionId, setSshConnectionId] = useState("");
  const [remotePath, setRemotePath] = useState("~");
  const [wslDistribution, setWslDistribution] = useState("");
  const [wslWorkingDirectory, setWslWorkingDirectory] = useState("");
  const [distributions, setDistributions] = useState<string[]>([]);
  const [distributionsLoading, setDistributionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createProject = useProjectStore((s) => s.createProject);
  const connections = useSshStore((s) => s.connections);
  const loadConnections = useSshStore((s) => s.loadConnections);
  const platformInfo = usePlatformStore((s) => s.info);
  const wslSupported = platformInfo?.wslSupported ?? false;
  const availableProjectTypes = useMemo<readonly ProjectType[]>(
    () => platformInfo?.availableProjectTypes ?? ["local", "wsl", "ssh"],
    [platformInfo],
  );

  // If the platform snapshot loads after the dialog opens and the current
  // type is no longer offered (e.g. WSL on Linux), fall back to local so the
  // user is never stuck on an unsupported type.
  useEffect(() => {
    if (
      openState &&
      type &&
      !availableProjectTypes.includes(type) &&
      availableProjectTypes.length > 0
    ) {
      setType(availableProjectTypes[0] as ProjectType);
    }
  }, [openState, type, availableProjectTypes]);

  useEffect(() => {
    if (openState) void loadConnections();
  }, [openState, loadConnections]);
  useEffect(() => {
    if (!openState || type !== "wsl" || !wslSupported) return;
    // Defer detection until the user picks the WSL type so a first-run dialog
    // does not block on `wsl.exe` when only local projects are wanted.
    let cancelled = false;
    setDistributionsLoading(true);
    environmentService
      .detectWslDistributions()
      .then((found) => {
        if (cancelled) return;
        const names = found.map((d) => d.name);
        setDistributions(names);
        // Auto-select the first detected distribution when the field is empty
        // so the user can create the project without an extra click.
        if (!wslDistribution && names.length > 0) {
          setWslDistribution(names[0]);
        }
      })
      .catch(() => {
        if (!cancelled) setDistributions([]);
      })
      .finally(() => {
        if (!cancelled) setDistributionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Only re-run when the dialog opens for the WSL type; we intentionally do
    // not re-detect on every keystroke of the working-directory field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openState, type, wslSupported]);

  function reset() {
    setName("");
    setType("local");
    setLocalPath("");
    setSshConnectionId("");
    setRemotePath("~");
    setWslDistribution("");
    setWslWorkingDirectory("");
    setDistributions([]);
    setError(null);
  }

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setLocalPath(selected);
    }
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }
    if (type === "local" && !localPath.trim()) {
      setError("Local path is required");
      return;
    }
    if (type === "ssh" && !sshConnectionId) {
      setError("Choose an SSH connection first");
      return;
    }
    if (type === "ssh" && !remotePath.trim()) {
      setError("Remote path is required");
      return;
    }
    if (type === "wsl" && !wslDistribution.trim()) {
      setError("Select a WSL distribution");
      return;
    }
    const input: ProjectInput = {
      name: name.trim(),
      type,
      ...(type === "local"
        ? { local: { path: localPath.trim() } }
        : type === "wsl"
          ? {
              wsl: {
                distribution: wslDistribution.trim(),
                workingDirectory: wslWorkingDirectory.trim() || undefined,
              },
            }
          : {
              ssh: {
                connectionId: sshConnectionId,
                remotePath: remotePath.trim(),
              },
            }),
    };
    setSubmitting(true);
    setError(null);
    try {
      await createProject(input);
      reset();
      setOpenState(false);
    } catch (e) {
      const err = e as { message?: string };
      setError(err.message ?? "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={openState}
      onOpenChange={(v) => {
        setOpenState(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Create a local, WSL, or SSH remote project. Each project gets its
            own terminal tab group.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="project-type">Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as ProjectType)}
            >
              <SelectTrigger id="project-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableProjectTypes.includes("local") ? (
                  <SelectItem value="local">Local folder</SelectItem>
                ) : null}
                {availableProjectTypes.includes("wsl") ? (
                  <SelectItem value="wsl">WSL distribution</SelectItem>
                ) : null}
                {availableProjectTypes.includes("ssh") ? (
                  <SelectItem value="ssh">SSH remote</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>

          {type === "local" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-path">Local path</Label>
              <div className="flex gap-2">
                <Input
                  id="project-path"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={pickFolder}
                  aria-label="Browse folder"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : null}

          {type === "wsl" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="wsl-distribution">WSL distribution</Label>
                {distributions.length > 0 ? (
                  <Select
                    value={wslDistribution}
                    onValueChange={setWslDistribution}
                  >
                    <SelectTrigger id="wsl-distribution">
                      <SelectValue
                        placeholder={
                          distributionsLoading
                            ? "Detecting distributions..."
                            : "Choose a distribution"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {distributions.map((distro) => (
                        <SelectItem key={distro} value={distro}>
                          {distro}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="wsl-distribution"
                    value={wslDistribution}
                    onChange={(e) => setWslDistribution(e.target.value)}
                    placeholder={
                      distributionsLoading
                        ? "Detecting distributions..."
                        : "e.g. Ubuntu"
                    }
                  />
                )}
                {distributions.length === 0 && !distributionsLoading ? (
                  <span className="text-xs text-muted-foreground">
                    No distributions detected. Type a name manually or install
                    WSL via `wsl --install`.
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="wsl-working-directory">
                  Working directory (optional)
                </Label>
                <Input
                  id="wsl-working-directory"
                  value={wslWorkingDirectory}
                  onChange={(e) => setWslWorkingDirectory(e.target.value)}
                  placeholder="e.g. /home/user/project"
                />
                <span className="text-xs text-muted-foreground">
                  Linux path inside the distribution. Leave blank to start in
                  the WSL user&apos;s home directory.
                </span>
              </div>
            </div>
          ) : null}

          {type === "ssh" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="ssh-connection">SSH connection</Label>
                  <SshConnectionDialog
                    onClosed={() => void loadConnections()}
                    trigger={
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-xs"
                      >
                        Manage connections
                      </Button>
                    }
                  />
                </div>
                <Select
                  value={sshConnectionId}
                  onValueChange={setSshConnectionId}
                >
                  <SelectTrigger id="ssh-connection">
                    <SelectValue
                      placeholder={
                        connections.length
                          ? "Choose a connection"
                          : "No saved connections"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.name} - {connection.host}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {connections.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Create a reusable SSH connection before adding this project.
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="remote-path">Remote path</Label>
                <div className="flex gap-2">
                  <Input
                    id="remote-path"
                    value={remotePath}
                    onChange={(event) => setRemotePath(event.target.value)}
                  />
                  <RemoteFolderPicker
                    connectionId={sshConnectionId}
                    initialPath={remotePath}
                    onSelect={setRemotePath}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  Browse folders after choosing a connection, or type a remote
                  working directory manually.
                </span>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpenState(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Creating..." : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
