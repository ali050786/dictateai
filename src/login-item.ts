import { app, shell } from 'electron';

// "Open DictateAI when you log in". macOS keeps this setting (System Settings
// → General → Login Items), so it's always read back from there, never from
// config.json. Electron registers the app with SMAppService (macOS 13+).

export interface LoginItemState {
  // Only the installed app can be a login item: in development it would
  // register the bare Electron binary.
  available: boolean;
  enabled: boolean;
  // Switched off in System Settings. Only the user can turn it on there.
  needsApproval: boolean;
}

export function getLoginItemState(): LoginItemState {
  if (!app.isPackaged)
    return { available: false, enabled: false, needsApproval: false };
  const { openAtLogin, status } = app.getLoginItemSettings();
  const needsApproval = status === 'requires-approval';
  return {
    available: true,
    enabled: openAtLogin && !needsApproval,
    needsApproval,
  };
}

export function setOpenAtLogin(enabled: boolean): LoginItemState {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: enabled });
    console.log(
      `[DictateAI] Open at login: ${enabled} (macOS says ${app.getLoginItemSettings().status})`,
    );
  }
  return getLoginItemState();
}

export function openLoginItemsSettings(): void {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  );
}
