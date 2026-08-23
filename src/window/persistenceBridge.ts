import {
  persistenceService,
  type DurableCollectionSnapshot,
  type DurableProjectCollection,
  type DurableProjectMemo,
  type FrontendPersistenceMigrationResult,
  type FrontendPersistencePayload,
} from "@/services";

export const GENERAL_SETTINGS_STORAGE_KEY = "project-terminal.general-settings";
export const COLLECTIONS_STORAGE_KEY = "project-terminal.collections";
export const MEMOS_STORAGE_KEY = "project-terminal.project-memos.v1";
export const LEGACY_WORKSPACE_STORAGE_KEY =
  "project-terminal.workspace-layout.v1";
export const WORKSPACE_STORAGE_PREFIX = "project-terminal.workspace-layout.v2:";

interface LocalStorageSource {
  key: string;
  value: unknown;
}

export interface LocalPersistenceMigrationInput {
  payload: FrontendPersistencePayload;
  sourceKeys: {
    generalSettings?: string;
    collections?: string;
    memos?: string;
    workspaces: Map<string, string>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapPersistedValue(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.state)) return value.state;
  return value;
}

function readSource(key: string): LocalStorageSource | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch (error) {
    console.warn(`Could not read localStorage key ${key}`, error);
    return null;
  }
  if (raw === null) return null;
  try {
    return { key, value: unwrapPersistedValue(JSON.parse(raw)) };
  } catch (error) {
    console.warn(`Ignoring corrupt localStorage key ${key}`, error);
    return null;
  }
}

function stringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return null;
  }
  return value;
}

function booleanRecord(value: unknown): Record<string, boolean> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "boolean")) return null;
  return Object.fromEntries(entries) as Record<string, boolean>;
}

function parseGeneralSettings(
  source: LocalStorageSource | null,
): Record<string, unknown> | null {
  if (!source) return null;
  if (!isRecord(source.value)) {
    console.warn(`Ignoring invalid localStorage key ${source.key}`);
    return null;
  }
  return source.value;
}

function parseCollection(value: unknown): DurableProjectCollection | null {
  if (!isRecord(value)) return null;
  const projectIds = stringArray(value.projectIds);
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !projectIds ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    projectIds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseCollections(
  source: LocalStorageSource | null,
): DurableCollectionSnapshot | null {
  if (!source) return null;
  if (!isRecord(source.value) || !Array.isArray(source.value.collections)) {
    console.warn(`Ignoring invalid localStorage key ${source.key}`);
    return null;
  }
  const collections = source.value.collections.map(parseCollection);
  const ungroupedProjectIds = stringArray(source.value.ungroupedProjectIds);
  const collapsed = booleanRecord(source.value.collapsed);
  if (
    collections.some((collection) => collection === null) ||
    !ungroupedProjectIds ||
    !collapsed
  ) {
    console.warn(`Ignoring invalid localStorage key ${source.key}`);
    return null;
  }
  return {
    collections: collections as DurableProjectCollection[],
    collapsed,
    ungroupedProjectIds,
  };
}

function parseMemo(
  projectId: string,
  value: unknown,
): DurableProjectMemo | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    (kind !== "markdown" && kind !== "command") ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    return null;
  }
  if (value.projectId !== undefined && value.projectId !== projectId) {
    return null;
  }
  return {
    id: value.id,
    projectId,
    kind,
    title: value.title,
    content: typeof value.content === "string" ? value.content : "",
    description: typeof value.description === "string" ? value.description : "",
    command: typeof value.command === "string" ? value.command : "",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseMemos(
  source: LocalStorageSource | null,
): Record<string, DurableProjectMemo[]> | null {
  if (!source) return null;
  if (!isRecord(source.value) || !isRecord(source.value.memosByProjectId)) {
    console.warn(`Ignoring invalid localStorage key ${source.key}`);
    return null;
  }
  const projectMemos: Record<string, DurableProjectMemo[]> = {};
  for (const [projectId, rawMemos] of Object.entries(
    source.value.memosByProjectId,
  )) {
    if (!Array.isArray(rawMemos)) {
      console.warn(`Ignoring invalid localStorage key ${source.key}`);
      return null;
    }
    const memos = rawMemos.map((memo) => parseMemo(projectId, memo));
    if (memos.some((memo) => memo === null)) {
      console.warn(`Ignoring invalid localStorage key ${source.key}`);
      return null;
    }
    projectMemos[projectId] = memos as DurableProjectMemo[];
  }
  return projectMemos;
}

function parseWorkspace(
  source: LocalStorageSource,
): Record<string, unknown> | null {
  if (!isRecord(source.value)) {
    console.warn(`Ignoring invalid localStorage key ${source.key}`);
    return null;
  }
  return source.value;
}

function localStorageKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).filter((key): key is string => key !== null);
  } catch (error) {
    console.warn(
      "Could not enumerate localStorage for persistence migration",
      error,
    );
    return [];
  }
}

export function collectLocalPersistence(): LocalPersistenceMigrationInput {
  const payload: FrontendPersistencePayload = {};
  const sourceKeys: LocalPersistenceMigrationInput["sourceKeys"] = {
    workspaces: new Map(),
  };

  const settingsSource = readSource(GENERAL_SETTINGS_STORAGE_KEY);
  const settings = parseGeneralSettings(settingsSource);
  if (settings) {
    payload.generalSettings = settings;
    sourceKeys.generalSettings = GENERAL_SETTINGS_STORAGE_KEY;
  }

  const collectionsSource = readSource(COLLECTIONS_STORAGE_KEY);
  const collections = parseCollections(collectionsSource);
  if (collections) {
    payload.collections = collections;
    sourceKeys.collections = COLLECTIONS_STORAGE_KEY;
  }

  const memosSource = readSource(MEMOS_STORAGE_KEY);
  const projectMemos = parseMemos(memosSource);
  if (projectMemos) {
    payload.projectMemos = projectMemos;
    sourceKeys.memos = MEMOS_STORAGE_KEY;
  }

  const workspaceSources: LocalStorageSource[] = [];
  const legacyWorkspace = readSource(LEGACY_WORKSPACE_STORAGE_KEY);
  if (legacyWorkspace && parseWorkspace(legacyWorkspace)) {
    workspaceSources.push(legacyWorkspace);
  }
  for (const key of localStorageKeys()) {
    if (!key.startsWith(WORKSPACE_STORAGE_PREFIX)) continue;
    const workspaceId = key.slice(WORKSPACE_STORAGE_PREFIX.length);
    if (!workspaceId) {
      console.warn(`Ignoring invalid localStorage key ${key}`);
      continue;
    }
    const source = readSource(key);
    if (source && parseWorkspace(source)) workspaceSources.push(source);
  }

  // The old v1 single-window layout has precedence over a v2 `main` layout,
  // matching the existing workspace boot migration semantics.
  const hasLegacyMain = workspaceSources.some(
    (source) => source.key === LEGACY_WORKSPACE_STORAGE_KEY,
  );
  for (const source of workspaceSources) {
    const workspaceId =
      source.key === LEGACY_WORKSPACE_STORAGE_KEY
        ? "main"
        : source.key.slice(WORKSPACE_STORAGE_PREFIX.length);
    if (
      workspaceId === "main" &&
      hasLegacyMain &&
      source.key !== LEGACY_WORKSPACE_STORAGE_KEY
    ) {
      continue;
    }
    if (sourceKeys.workspaces.has(workspaceId)) continue;
    const workspace = parseWorkspace(source);
    if (!workspace) continue;
    payload.workspaceStates ??= {};
    payload.workspaceStates[workspaceId] = workspace;
    sourceKeys.workspaces.set(workspaceId, source.key);
  }

  return { payload, sourceKeys };
}

function removeSource(key: string) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`Could not remove migrated localStorage key ${key}`, error);
  }
}

/**
 * Move valid browser/Zustand snapshots into SQLite. Source keys are removed
 * only after the backend transaction succeeds; malformed or failed data stays
 * in localStorage for recovery and diagnosis.
 */
export async function migrateLocalPersistence(): Promise<FrontendPersistenceMigrationResult | null> {
  const input = collectLocalPersistence();
  const { payload, sourceKeys } = input;
  if (
    payload.generalSettings === undefined &&
    payload.collections === undefined &&
    payload.projectMemos === undefined &&
    payload.workspaceStates === undefined
  ) {
    return null;
  }

  let result: FrontendPersistenceMigrationResult;
  try {
    result = await persistenceService.migrateFrontendPersistence(payload);
  } catch (error) {
    console.error(
      "Frontend persistence migration failed; keeping localStorage sources",
      error,
    );
    return null;
  }

  if (result.generalSettings && sourceKeys.generalSettings) {
    removeSource(sourceKeys.generalSettings);
  }
  if (result.collections && sourceKeys.collections) {
    removeSource(sourceKeys.collections);
  }
  if (result.projectMemos && sourceKeys.memos) {
    removeSource(sourceKeys.memos);
  }
  for (const workspaceId of result.workspaces) {
    const sourceKey = sourceKeys.workspaces.get(workspaceId);
    if (sourceKey) removeSource(sourceKey);
  }
  return result;
}
