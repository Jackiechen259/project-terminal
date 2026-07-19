import { useEffect, useState } from "react";
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
import type { ProjectInput } from "@/services";
import { SshConnectionDialog } from "@/components/ssh/SshConnectionDialog";

/**
 * Add a local folder or an SSH remote project. SSH connections are reusable:
 * projects store only the selected connection id and their remote path.
 */
export function ProjectDialog({ trigger }: { trigger: React.ReactNode }) {
  const [openState, setOpenState] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "ssh">("local");
  const [localPath, setLocalPath] = useState("");
  const [sshConnectionId, setSshConnectionId] = useState("");
  const [remotePath, setRemotePath] = useState("~");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createProject = useProjectStore((s) => s.createProject);
  const connections = useSshStore((s) => s.connections);
  const loadConnections = useSshStore((s) => s.loadConnections);

  useEffect(() => {
    if (openState) void loadConnections();
  }, [openState, loadConnections]);

  function reset() {
    setName("");
    setType("local");
    setLocalPath("");
    setSshConnectionId("");
    setRemotePath("~");
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
    const input: ProjectInput = {
      name: name.trim(),
      type,
      ...(type === "local" ? { local: { path: localPath.trim() } } : { ssh: { connectionId: sshConnectionId, remotePath: remotePath.trim() } }),
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
            Create a local or SSH remote project. Each project gets its own
            terminal tab group.
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
              onValueChange={(v) => setType(v as "local" | "ssh")}
            >
              <SelectTrigger id="project-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local folder</SelectItem>
                <SelectItem value="ssh">SSH remote</SelectItem>
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

          {type === "ssh" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3"><Label htmlFor="ssh-connection">SSH connection</Label><SshConnectionDialog onClosed={() => void loadConnections()} trigger={<Button type="button" variant="link" className="h-auto p-0 text-xs">Manage connections</Button>} /></div>
                <Select value={sshConnectionId} onValueChange={setSshConnectionId}>
                  <SelectTrigger id="ssh-connection"><SelectValue placeholder={connections.length ? "Choose a connection" : "No saved connections"} /></SelectTrigger>
                  <SelectContent>{connections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.name} — {connection.host}</SelectItem>)}</SelectContent>
                </Select>
                {connections.length === 0 ? <span className="text-xs text-muted-foreground">Create a reusable SSH connection before adding this project.</span> : null}
              </div>
              <div className="flex flex-col gap-2"><Label htmlFor="remote-path">Remote path</Label><Input id="remote-path" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} /><span className="text-xs text-muted-foreground">The remote working directory. It is used when interactive SSH terminals are added in Phase 6.</span></div>
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
