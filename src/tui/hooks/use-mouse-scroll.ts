import React from "react";

/**
 * Ink 3 binds stdin for useInput; enabling SGR mouse tracking would compete with the same stream.
 * Transcript scrolling uses PageUp/PageDown (see chat help). Revisit when upgrading Ink or splitting input.
 */
export function useMouseScrollUnsupportedNotice(): void {
  React.useEffect(() => {
    // Intentionally empty: reserved for a future raw-stdin bridge without breaking useInput.
  }, []);
}
