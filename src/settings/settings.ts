// Plugin settings shape. Pure sync2 after the Stage 7 cutover —
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

  // Per-device gate for paths under `<configDir>/`. When OFF, the
  // sync engine treats every configDir path as ignored EXCEPT the
  // two invariant gitignores (`<configDir>/.gitignore` and
  // `<configDir>/plugins/<self>/.gitignore`) — those propagate
  // regardless, because they encode shared rules every device must
  // agree on (including the "Push plugins data.json" toggle line).
  //
  // Stored here (per-device data.json) rather than the gitignore
  // because, by design, devices may disagree: one machine syncs its
  // Obsidian configs and the other doesn't. data.json is hard-blocked
  // from sync, so there's no propagation channel for this preference.
  //
  // Default `false`: explicit opt-in. Obsidian configs include
  // workspace state, theme settings, and plugin install state — many
  // users (especially multi-device users) don't want one machine's
  // layout to overwrite another's. The two invariant gitignores
  // still sync regardless so shared rules (denylist, plugin-folder
  // allowlist) converge across devices.
  syncConfigDir?: boolean;

  // Pull-side + click-time text canonicalization (CRLF→LF, BOM strip,
  // trailing-NL). Default `true` — the engine rewrites non-canonical
  // text bytes both locally on pull AND when copying the user's edits
  // into a batch on click. Set `false` if you have a real reason to
  // preserve byte-exact text round-trips with GitHub (e.g., a repo
  // shared with Windows users whose tooling expects CRLF, or files
  // whose trailing-newline matters). With this off, plugin treats
  // text the same as binary at the byte level.
  autoCanonicalizeTextFiles?: boolean;
}

// NOTE: "Push plugins data.json to GitHub" is NOT a per-device
// setting field. Its source of truth is the presence of the line
// `!plugins/*/data.json` in `<configDir>/.gitignore`. The
// settings-tab checkbox reads/writes that file via
// GitignoreInvariants.getPushPluginsDataJson / setPushPluginsDataJson.
// Storing it here would have to either (a) duplicate state with the
// gitignore (drift risk) or (b) propagate cross-device differently
// from the gitignore itself (ping-pong on devices that disagree).
// Letting the gitignore be the single source keeps both devices
// converging on the same policy as soon as one of them pushes the
// gitignore.

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  syncStrategy: "manual",
  syncInterval: 5,
  syncOnStartup: false,
  autoCommitOnSync: false,
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  enableLogging: false,
  commitMessageAll: "Sync at {date} {time}",
  commitMessageFile: "Update {filename} at {date} {time}",
  accumulateOfflineSyncs: false,
  deviceLabel: "Obsidian",
  syncConfigDir: false,
  autoCanonicalizeTextFiles: true,
};
