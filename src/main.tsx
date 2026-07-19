import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
