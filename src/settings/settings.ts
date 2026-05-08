// Plugin settings shape. Pure sync2 after the Etap 7 cutover —
// legacy fields (firstSync, deviceName, conflictHandling,
// conflictViewMode, keepPluginConflictCopy, syncConfigDir,
// experimentalSync2, showConflictsRibbonButton) are no longer
// declared here; if older data.json files contain them, they
// silently load into Object.assign and remain in memory but
// nothing reads them. Saving normalises back to the shape below.
export interface GitHubSyncSettings {
  // GitHub repo coordinates.
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;

  // Auto-sync.
  syncStrategy: "manual" | "interval";
  syncInterval: number; // minutes
  syncOnStartup: boolean;
  // What an AUTOMATIC sync (interval timer OR sync-on-startup) does
  // for local changes. The manual [Sync with GitHub] button always
  // commits regardless — this setting only governs the automatic
  // surfaces:
  //   - false (default): pull-only on interval; pull + drain queue
  //                      on startup. Local edits are NEVER enqueued
  //                      automatically; the user commits explicitly.
  //                      Silent — no "Commit"/"Syncing" notices on
  //                      idle. Conflicts during pull auto-defer via
  //                      ConflictStore (the 🔀 status-bar widget
  //                      surfaces them).
  //   - true:           full sync (commit + pull + push) on both
  //                      interval and startup, same flow and same
  //                      Notices as a manual click. Local changes
  //                      go up automatically; if accumulateOfflineSyncs
  //                      is also true, sequential automatic syncs
  //                      collapse into one combined commit.
  autoCommitOnSync?: boolean;

  // UI affordances.
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;

  enableLogging: boolean;

  // Sync2 commit-message templates. Placeholders: {date}, {filename},
  // {path}. {filename}/{path} only meaningful in commitMessageFile.
  // The deviceLabel is appended as a fixed " (label)" suffix
  // automatically — see commit-templates.ts → appendDeviceSuffix.
  commitMessageAll?: string;
  commitMessageFile?: string;

  // When sync2 is offline (last push failed) and this is true,
  // subsequent Sync clicks fold into the latest pending batch
  // instead of stacking. Eventual replay is one commit.
  accumulateOfflineSyncs?: boolean;

  // Per-device label baked into commit messages (as the trailing
  // suffix) and conflict-resolver sibling-file names. Same source
  // for both surfaces — change once, both update. Default
  // "Obsidian" reads naturally even for a single-device user
  // ("Sync at <date> (Obsidian)" — synced from Obsidian, the app).
  // Multi-device users override per machine ("Phone", "Desktop"…).
  deviceLabel?: string;
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  syncStrategy: "manual",
  syncInterval: 1,
  syncOnStartup: false,
  autoCommitOnSync: false,
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  enableLogging: false,
  commitMessageAll: "Sync at {date} {time}",
  commitMessageFile: "Update {filename} at {date} {time}",
  accumulateOfflineSyncs: false,
  deviceLabel: "Obsidian",
};
