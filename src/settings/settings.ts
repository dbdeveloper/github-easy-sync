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
  // Hidden flag: when true, the plugin uses Sync2Manager instead of
  // the legacy SyncManager. Off by default; flipped manually in
  // data.json during sync2 development. Removed at the cutover commit
  // when sync2 replaces legacy outright.
  experimentalSync2?: boolean;
  // Sync2 commit-message templates. Placeholders: {date}, {filename},
  // {path}. {filename}/{path} only meaningful in commitMessageFile.
  commitMessageAll?: string;
  commitMessageFile?: string;
  // When sync2 is offline (last push failed) and this is true,
  // subsequent Sync clicks fold into the latest pending batch instead
  // of stacking. Eventual replay is one commit.
  accumulateOfflineSyncs?: boolean;
  // Sync2 conflict resolver (Etap 6.5): label baked into the
  // sibling-file name `<base>.conflict-from-<deviceLabel>-<ts>.<ext>`
  // and into the conflict-store metadata so a multi-device user can
  // distinguish which device contributed which conflict copy. Pure
  // local; never propagates through sync. Defaults to "this-device";
  // users with multiple devices set it explicitly per device.
  deviceLabel?: string;
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
  experimentalSync2: false,
  // Templates handle the human-readable part. The deviceLabel is
  // appended automatically as a fixed-position " (label)" suffix by
  // appendDeviceSuffix(), so it's parseable from any commit on GitHub
  // regardless of how the user edits these templates. Default
  // deviceLabel = "Obsidian" reads naturally for single-device users
  // ("Sync at <date> (Obsidian)" — synced from Obsidian, the app);
  // multi-device users override it per machine ("Phone", "Desktop"…).
  commitMessageAll: "Sync at {date}",
  commitMessageFile: "Update {filename} at {date}",
  accumulateOfflineSyncs: false,
  deviceLabel: "Obsidian",
};
