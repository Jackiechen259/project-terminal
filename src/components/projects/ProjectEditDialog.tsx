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
import type { Project } from "@/types";

export function ProjectEditDialog({
  project,
  openState,
  onOpenChange,
}: {
  project: Project;
  openState: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(project.name);
  const [localPath, setLocalPath] = useState(project.local?.path ?? "");
  const [connectionId, setConnectionId] = useState(
    project.ssh?.connectionId ?? "",
  );
  const [remotePath, setRemotePath] = useState(project.ssh?.remotePath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const connections = useSshStore((state) => state.connections);
  const loadConnections = useSshStore((state) => state.loadConnections);
  const updateProject = useProjectStore((state) => state.updateProject);

  useEffect(() => {
    if (!openState) return;
    setName(project.name);
    setLocalPath(project.local?.path ?? "");
    setConnectionId(project.ssh?.connectionId ?? "");
    setRemotePath(project.ssh?.remotePath ?? "");
    setError(null);
    if (project.type === "ssh") void loadConnections();
  }, [openState, project, loadConnections]);

  async function chooseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setLocalPath(selected);
  }

  async function save() {
    if (!name.trim()) return setError("Project name is required.");
    if (project.type === "local" && !localPath.trim())
      return setError("Local path is required.");
    if (project.type === "ssh" && (!connectionId || !remotePath.trim()))
      return setError("SSH connection and remote path are required.");
    setSaving(true);
    setError(null);
    try {
      await updateProject({
        id: project.id,
        name: name.trim(),
        type: project.type,
        ...(project.type === "local"
          ? { local: { path: localPath.trim() } }
          : { ssh: { connectionId, remotePath: remotePath.trim() } }),
        defaultProfileId: project.defaultProfileId,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(
        (cause as { message?: string }).message ?? "Unable to update project.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={openState} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>
            Changing a project does not close its existing terminal sessions.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-project-name">Project name</Label>
            <Input
              id="edit-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {project.type === "local" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-project-path">Local path</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-project-path"
                  value={localPath}
                  onChange={(event) => setLocalPath(event.target.value)}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={() => void chooseFolder()}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label>SSH connection</Label>
                <Select value={connectionId} onValueChange={setConnectionId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.name} — {connection.host}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-remote-path">Remote path</Label>
                <Input
                  id="edit-remote-path"
                  value={remotePath}
                  onChange={(event) => setRemotePath(event.target.value)}
                />
              </div>
            </>
          )}
          {error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
