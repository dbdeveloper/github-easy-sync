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
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  enableLogging: false,
  commitMessageAll: "Sync at {date}",
  commitMessageFile: "Update {filename} at {date}",
  accumulateOfflineSyncs: false,
  deviceLabel: "Obsidian",
};
