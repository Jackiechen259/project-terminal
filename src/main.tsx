import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import App from "./App";
import "./index.css";
import { WindowWorkspaceProvider } from "./window/WindowWorkspaceProvider";
import { prepareWorkspace } from "./window/windowBoot";
import type { WorkspaceInfo } from "./window/windowService";

// Prevent WebView2 from showing its Edge context menu on any surface. Individual
// components can still open an application-owned menu from the same event.
document.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  { capture: true },
);

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Project Terminal render failed", error);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="flex h-full w-full items-center justify-center bg-background p-6 text-foreground">
          <section className="max-w-xl rounded-md border border-destructive/50 bg-destructive/10 p-5">
            <h1 className="text-base font-semibold">
              Project Terminal could not start
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {this.state.error.message}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              Open the development console or restart the app after resolving
              the error.
            </p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

function renderApp(info: WorkspaceInfo | null) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <WindowWorkspaceProvider info={info ?? fallbackInfo()}>
          <App />
        </WindowWorkspaceProvider>
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

/**
 * Boot-failure fallback: the UI must still render even when the backend
 * workspace handshake failed. The fallback workspace is this WebView's own
 * label (Tauri exposes it synchronously); in the single-window architecture
 * that label is always `main`.
 */
function fallbackInfo(): WorkspaceInfo {
  let label = "main";
  try {
    label = getCurrentWebview().label;
  } catch {
    // Plain browser dev / tests: the main workspace id.
  }
  return {
    windowLabel: label,
    workspaceId: label,
    projectId: null,
    migratedFromWorkspaceId: null,
  };
}

// Resolve the workspace identity and hydrate its layout before the first
// frame renders, so a restored window never flashes its empty state. The
// static startup shell in index.html stays visible until then. The boot is
// bounded (see `windowBoot.ts`); any failure falls back to rendering with
// the window's own label as its workspace.
void prepareWorkspace()
  .then(renderApp)
  .catch((error) => {
    console.error("Failed to resolve workspace, using legacy fallback", error);
    renderApp(null);
  });
