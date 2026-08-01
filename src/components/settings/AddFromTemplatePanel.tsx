import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { findProfileByName } from "@/lib/profilePresets";
import { getProfileTemplateIcon } from "@/lib/profileTemplateIcons";
import { launchSummary } from "@/lib/profileSummary";
import { cn } from "@/lib/utils";
import type { ProfileTemplate, TerminalProfile } from "@/types";

/**
 * Picks which global profile templates to materialize as profiles of the
 * selected project. Templates whose name a profile already claims are shown
 * but cannot be picked, since adding one would only duplicate that profile.
 */
export function AddFromTemplatePanel({
  templates,
  profiles,
  projectName,
  loading,
  loadError,
  onAdd,
  onCancel,
}: {
  templates: ProfileTemplate[];
  profiles: TerminalProfile[];
  projectName: string;
  loading: boolean;
  /** Set when the template list itself could not be loaded. */
  loadError?: string | null;
  onAdd: (selected: ProfileTemplate[]) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const error = addError ?? loadError ?? null;

  const rows = useMemo(
    () =>
      templates.map((template) => ({
        template,
        alreadyAdded: Boolean(findProfileByName(profiles, template.name)),
      })),
    [templates, profiles],
  );
  const selectable = useMemo(
    () => rows.filter((row) => !row.alreadyAdded),
    [rows],
  );
  const allSelected =
    selectable.length > 0 &&
    selectable.every((row) => selected.has(row.template.id));

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function runAdd() {
    try {
      setAdding(true);
      setAddError(null);
      await onAdd(templates.filter((template) => selected.has(template.id)));
    } catch (cause) {
      setAddError(
        (cause as { message?: string }).message ??
          t("Could not add profiles from templates."),
      );
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">{t("Add from template")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('Choose which profile templates to add to "{project}".', {
            project: projectName,
          })}
        </p>
      </div>

      {loading ? (
        <p className="py-6 text-sm text-muted-foreground">
          {t("Loading templates…")}
        </p>
      ) : null}

      {!loading && !loadError && rows.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {t(
            "No profile templates yet. Create one on the Profile templates page first.",
          )}
        </p>
      ) : null}

      {!loading && rows.length > 0 ? (
        <>
          <div className="flex items-center justify-between border-b pb-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(selectable.map((row) => row.template.id)),
                  )
                }
              />
              {t("Select all")}
            </label>
            <span className="text-xs text-muted-foreground">
              {t("{count} selected", { count: selected.size })}
            </span>
          </div>

          <div className="app-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
            {rows.map(({ template, alreadyAdded }) => {
              const TemplateIcon = getProfileTemplateIcon(template.icon);
              return (
                <label
                  key={template.id}
                  className={cn(
                    "flex items-start gap-3 rounded-md px-2 py-2 text-sm",
                    alreadyAdded
                      ? "opacity-60"
                      : "cursor-pointer hover:bg-accent",
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                    checked={selected.has(template.id)}
                    disabled={alreadyAdded}
                    onChange={() => toggle(template.id)}
                  />
                  <TemplateIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">
                        {template.name}
                      </span>
                      {alreadyAdded ? (
                        <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t("Already added")}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                      {launchSummary(template)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t pt-4">
        <Button variant="ghost" onClick={onCancel} disabled={adding}>
          <ChevronLeft className="h-4 w-4" /> {t("Cancel")}
        </Button>
        <Button
          onClick={() => void runAdd()}
          disabled={adding || loading || selected.size === 0}
        >
          {adding ? t("Adding…") : t("Add selected")}
        </Button>
      </div>
    </div>
  );
}
