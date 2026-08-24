# Persistence v2

Project Terminal stores durable application state in SQLite. On Windows the
database is:

```text
%APPDATA%\ProjectTerminal\project-terminal.db
```

The Rust backend opens the database before the Tauri window is created. SQLite
is bundled with `rusqlite`, foreign-key enforcement is enabled, and schema
changes are recorded in `schema_migrations`. The current schema contains
normalized tables for projects, profiles, profile templates, SSH connection
metadata, imported colour schemes, settings, collections, collection
memberships, project memos, workspace state, and application metadata.

## Startup migration from backend JSON

On the first startup after the SQLite migration, the backend checks these
legacy files:

```text
projects.json
profiles.json
profile-templates.json
ssh-connections.json
color-schemes.json
```

The migration validates the JSON and model ids, creates a timestamped backup
under `backups\legacy-before-sqlite-*`, and imports all records in one SQLite
transaction. The original JSON files are not deleted or overwritten. A
`legacy_backend_migrated` metadata marker makes the operation idempotent; a
failed validation or transaction leaves the originals available for recovery.

## Frontend state migration

The desktop WebView used to persist UI-owned state in Zustand/localStorage.
Before normal hydration, the Tauri boot sequence reads valid snapshots from:

```text
project-terminal.general-settings
project-terminal.collections
project-terminal.project-memos.v1
project-terminal.workspace-layout.v1
project-terminal.workspace-layout.v2:{workspaceId}
```

The snapshots are sent to one backend transaction. Settings, collections,
memos, and workspace layouts are then hydrated from SQLite. A source key is
removed only after the backend reports a successful migration. Corrupt keys or
a failed IPC/database migration are retained and reported to the console so
the user still has the original data to inspect or retry. Browser/dev runs
without Tauri continue to use localStorage as a test and fallback environment;
desktop writes are debounced and SQLite is authoritative there.

## Secrets and recovery

The `ssh_connections` table stores connection metadata and a
`password_saved` flag only. Saved SSH passwords remain in Windows Credential
Manager and are never written to SQLite or the legacy JSON files. Private-key
contents are never imported.

For a manual backup, close the application and copy
`project-terminal.db` together with the `backups` directory. Do not edit the
live database while the application is running. If a migration needs to be
recovered, keep the timestamped JSON backup and the original JSON files until
the imported data has been checked.

## Verification

The persistence paths are covered by Rust repository/migration tests and
Vitest tests for the localStorage bridge. Before shipping a persistence
change, run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm lint
pnpm build
pnpm test
```
