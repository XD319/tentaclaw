import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

class BootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  public constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  public static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  public render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="empty">
          AutoTalon failed to start.
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root");
}
createRoot(root).render(
  <React.StrictMode>
    <BootErrorBoundary>
      <App />
    </BootErrorBoundary>
  </React.StrictMode>
);
