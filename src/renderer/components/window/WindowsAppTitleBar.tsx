import React, { useEffect } from 'react';

import WindowTitleBar from './WindowTitleBar';

interface WindowsAppTitleBarProps {
  isOverlayActive?: boolean;
}

const WindowsAppTitleBar: React.FC<WindowsAppTitleBarProps> = ({ isOverlayActive = false }) => {
  useEffect(() => {
    if (window.electron.platform !== 'win32') return;

    const message = 'Windows app title bar mounted';
    console.debug(`[WindowsAppTitleBar] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'WindowsAppTitleBar', message);
    } catch {
      // Best-effort diagnostic only.
    }
  }, []);

  if (window.electron.platform !== 'win32') {
    return null;
  }

  return (
    <div className="draggable flex h-9 shrink-0 items-center justify-between border-b border-border bg-background px-3">
      <div className="flex min-w-0 items-center gap-2">
        <img
          src="logo.png"
          alt=""
          draggable={false}
          className="h-4 w-4 shrink-0"
        />
        <span className="truncate text-sm font-medium text-foreground">
          LobsterAI
        </span>
      </div>
      <WindowTitleBar inline isOverlayActive={isOverlayActive} />
    </div>
  );
};

export default WindowsAppTitleBar;
