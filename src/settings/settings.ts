export interface GitHubSyncSettings {
  firstSync: boolean;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  syncStrategy: "manual" | "interval";
  syncInterval: number;
  syncOnStartup: boolean;
  syncConfigDir: boolean;
  conflictHandling: "overwriteLocal" | "ask" | "overwriteRemote";
  conflictViewMode: "default" | "unified" | "split";
  // For atomic plugin .js conflicts (auto-resolved by manifest version
  // → timestamp → local-wins): when true, also keep the loser side as
  // <name>.conflict-(local|remote)-<timestamp>.js next to the winner so
  // nothing is silently overwritten. Off by default — plugin folders stay
  // tidy; users who want to compare versions can opt in.
  keepPluginConflictCopy: boolean;
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;
  showConflictsRibbonButton: boolean;
  enableLogging: boolean;
  // Per-device label that gets baked into GitHub commit messages so a
  // multi-device user can tell at a glance which machine produced a
  // given commit ("Sync from mobile ...", "Sync from work-laptop ...").
  // Stored in data.json — never propagates through the sync since
  // data.json itself is hard-blocked from upload.
  deviceName: string;
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  firstSync: true,
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  syncStrategy: "manual",
  syncInterval: 1,
  syncOnStartup: false,
  syncConfigDir: false,
  conflictHandling: "ask",
  conflictViewMode: "default",
  keepPluginConflictCopy: false,
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showConflictsRibbonButton: true,
  enableLogging: false,
  deviceName: "Obsidian",
};
