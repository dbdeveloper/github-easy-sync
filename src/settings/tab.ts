import {
  PluginSettingTab,
  App,
  Setting,
  TextComponent,
  Notice,
} from "obsidian";
import GitHubSyncPlugin from "src/main";
import { copyToClipboard } from "src/utils";
import {
  applyTemplate,
  appendDeviceSuffix,
} from "src/sync2/commit-templates";

// Sync2-only settings tab. Mirrors the shape of GitHubSyncSettings —
// every input here writes to one field and persists via saveSettings.
export default class GitHubSyncSettingsTab extends PluginSettingTab {
  plugin: GitHubSyncPlugin;

  constructor(app: App, plugin: GitHubSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Remote repository ────────────────────────────────────────────
    new Setting(containerEl).setName("Remote Repository").setHeading();

    let tokenInput: TextComponent;
    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        "A personal access token or fine-grained token with read+write access to your repository.",
      )
      .addButton((button) =>
        button.setIcon("eye-off").onClick(() => {
          if (tokenInput.inputEl.type === "password") {
            tokenInput.inputEl.type = "text";
            button.setIcon("eye");
          } else {
            tokenInput.inputEl.type = "password";
            button.setIcon("eye-off");
          }
        }),
      )
      .addText((text) => {
        text
          .setPlaceholder("Token")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (value) => {
            this.plugin.settings.githubToken = value;
            await this.plugin.saveSettings();
          }).inputEl.type = "password";
        tokenInput = text;
      });

    new Setting(containerEl)
      .setName("Owner")
      .setDesc("Owner of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Owner")
          .setValue(this.plugin.settings.githubOwner)
          .onChange(async (value) => {
            this.plugin.settings.githubOwner = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("Name of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Repository")
          .setValue(this.plugin.settings.githubRepo)
          .onChange(async (value) => {
            this.plugin.settings.githubRepo = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository branch")
      .setDesc("Branch to sync")
      .addText((text) =>
        text
          .setPlaceholder("Branch name")
          .setValue(this.plugin.settings.githubBranch)
          .onChange(async (value) => {
            this.plugin.settings.githubBranch = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Device identity ─────────────────────────────────────────────
    new Setting(containerEl).setName("Sync").setHeading();

    // Both commit-message inputs render a live preview directly
    // underneath. The preview substitutes example values for each
    // placeholder and appends the device suffix exactly as the
    // sync engine would on push, so the user sees on-GitHub shape
    // as they type. References captured in `previews` so the
    // device-label input can also nudge them when label changes.
    const previewSamples = {
      date: new Date(),
      filename: "test.md",
      path: "Notes/test.md",
    };
    const previews: Array<() => void> = [];
    const renderPreview = (template: string): string => {
      const base = applyTemplate(template, previewSamples);
      return appendDeviceSuffix(
        base,
        this.plugin.settings.deviceLabel ?? "Obsidian",
      );
    };

    new Setting(containerEl)
      .setName("Device label")
      .setDesc(
        "Label for this machine. Baked into commit messages as a trailing " +
          '" (label)" suffix and into conflict-resolution sibling-file names. ',
      )
      .addText((text) =>
        text
          .setPlaceholder("Obsidian")
          .setValue(this.plugin.settings.deviceLabel ?? "Obsidian")
          .onChange(async (value) => {
            this.plugin.settings.deviceLabel = value.trim() || "Obsidian";
            await this.plugin.saveSettings();
            // Refresh both commit-message previews — the trailing
            // suffix changed.
            for (const refresh of previews) refresh();
          }),
      );

    // ── Sync strategy ───────────────────────────────────────────────
    const syncStrategies = {
      manual: "Manually",
      interval: "On Interval",
    };
    const uploadStrategySetting = new Setting(containerEl)
      .setName("Sync strategy")
      .setDesc("How to sync files with the remote repository");

    let syncInterval = "1";
    if (this.plugin.settings.syncInterval) {
      syncInterval = this.plugin.settings.syncInterval.toString();
    }
    const intervalSettings = new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Interval in minutes between automatic syncs")
      .addText((text) =>
        text
          .setPlaceholder("Interval in minutes")
          .setValue(syncInterval)
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = parseInt(value) || 1;
            await this.plugin.saveSettings();
            this.plugin.restartSyncInterval();
          }),
      );
    intervalSettings.setDisabled(
      this.plugin.settings.syncStrategy !== "interval",
    );

    uploadStrategySetting.addDropdown((dropdown) =>
      dropdown
        .addOptions(syncStrategies)
        .setValue(this.plugin.settings.syncStrategy)
        .onChange(async (value: keyof typeof syncStrategies) => {
          intervalSettings.setDisabled(value !== "interval");
          this.plugin.settings.syncStrategy = value;
          await this.plugin.saveSettings();
          if (value === "interval") {
            this.plugin.startSyncInterval();
          } else {
            this.plugin.stopSyncInterval();
          }
        }),
    );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Trigger a sync as soon as Obsidian finishes loading.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-commit on automatic sync")
      .setDesc(
        "Governs interval-driven syncs AND sync-on-startup. " +
          "When ENABLED, automatic syncs do a full commit + pull + push " +
          "(same as clicking the Sync button). When DISABLED, " +
          "automatic syncs only pull remote changes silently — your local " +
          "edits are left for you to commit manually.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoCommitOnSync ?? false)
          .onChange(async (value) => {
            this.plugin.settings.autoCommitOnSync = value;
            await this.plugin.saveSettings();
          });
      });

    // ── Commit messages ─────────────────────────────────────────────
    const allDefault = "Sync at {date} {time}";
    const allSetting = new Setting(containerEl)
      .setName("Commit message — full sync")
      .setDesc(
        "Template used when pushing all local changes. " +
          "Placeholders: {date} (YYYY-MM-DD), {time} (HH:MM:SS.ccc). " +
          'A " (deviceLabel)" suffix is always appended automatically.',
      )
      .addText((text) =>
        text
          .setPlaceholder(allDefault)
          .setValue(this.plugin.settings.commitMessageAll ?? allDefault)
          .onChange(async (value) => {
            this.plugin.settings.commitMessageAll = value.trim() || allDefault;
            await this.plugin.saveSettings();
            updateAllPreview();
          }),
      );
    // Mount preview INSIDE the setting row's info column (the same
    // container that holds name + description) so it stays visually
    // attached to the input. Appending to containerEl breaks the
    // row rhythm and looks orphaned in themed UIs that draw a
    // background around each setting.
    const allPreview = makePreviewElement(allSetting.infoEl);
    const updateAllPreview = (): void => {
      const tpl = this.plugin.settings.commitMessageAll ?? allDefault;
      allPreview.setText(`Preview: "${renderPreview(tpl)}"`);
    };
    updateAllPreview();
    previews.push(updateAllPreview);

    const fileDefault = "Update {filename} at {date} {time}";
    const fileSetting = new Setting(containerEl)
      .setName("Commit message — single file")
      .setDesc(
        "Template used when pushing a single file. " +
          "Placeholders: {date} (YYYY-MM-DD), {time} (HH:MM:SS.ccc), " +
          "{filename}, {path}. " +
          'A " (deviceLabel)" suffix is always appended automatically.',
      )
      .addText((text) =>
        text
          .setPlaceholder(fileDefault)
          .setValue(this.plugin.settings.commitMessageFile ?? fileDefault)
          .onChange(async (value) => {
            this.plugin.settings.commitMessageFile =
              value.trim() || fileDefault;
            await this.plugin.saveSettings();
            updateFilePreview();
          }),
      );
    const filePreview = makePreviewElement(fileSetting.infoEl);
    const updateFilePreview = (): void => {
      const tpl = this.plugin.settings.commitMessageFile ?? fileDefault;
      filePreview.setText(`Preview: "${renderPreview(tpl)}"`);
    };
    updateFilePreview();
    previews.push(updateFilePreview);

    new Setting(containerEl)
      .setName("Accumulate offline syncs into one commit")
      .setDesc(
        "When the network is unavailable and a previous push is still " +
          "pending, fold subsequent Sync clicks into the same batch. " +
          "Eventual replay produces a single commit instead of one per click.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.accumulateOfflineSyncs ?? false)
          .onChange(async (value) => {
            this.plugin.settings.accumulateOfflineSyncs = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Push plugins data.json to GitHub")
      .setDesc(
        "OFF by default. data.json files for OTHER plugins often store " +
          "secrets (API tokens, account credentials, license keys) that the " +
          "user typically does NOT want published. Turning this on appends " +
          "`!plugins/*/data.json` to <configDir>/.gitignore, which propagates " +
          "to all devices via the synced gitignore — there's no separate " +
          "per-device field. NOTE: THIS plugin's own data.json is ALWAYS " +
          "blocked from sync (it carries the GitHub token); this toggle " +
          "never affects that.",
      )
      .addToggle((toggle) => {
        // Initial value comes asynchronously from <configDir>/.gitignore
        // — the file is the single source of truth. Render with a
        // safe-default `false` first, then update once the read
        // resolves. UI race-free because addToggle resolves synchronously.
        toggle.setValue(false);
        void this.plugin.invariants
          ?.getPushPluginsDataJson()
          .then((v) => toggle.setValue(v));
        toggle.onChange(async (value) => {
          await this.plugin.invariants?.setPushPluginsDataJson(value);
        });
      });

    // ── Interface ───────────────────────────────────────────────────
    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show status bar item")
      .setDesc(
        "Show 'GitHub' label in the status bar (plus the 🔀 conflict counter " +
          "when there are pending conflicts).",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showStatusBarItem)
          .onChange(async (value) => {
            this.plugin.settings.showStatusBarItem = value;
            await this.plugin.saveSettings();
            if (value) this.plugin.showStatusBarItem();
            else this.plugin.hideStatusBarItem();
          });
      });

    new Setting(containerEl)
      .setName("Show sync ribbon button")
      .setDesc("Display a refresh-cw ribbon button to trigger a full sync.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showSyncRibbonButton)
          .onChange(async (value) => {
            this.plugin.settings.showSyncRibbonButton = value;
            await this.plugin.saveSettings();
            if (value) this.plugin.showSyncRibbonIcon();
            else this.plugin.hideSyncRibbonIcon();
          });
      });

    // ── Logging ─────────────────────────────────────────────────────
    new Setting(containerEl).setName("Extra").setHeading();

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc(
        "Persist logs to <configDir>/github-easy-sync.log. Useful for bug reports.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableLogging)
          .onChange(async (value) => {
            this.plugin.settings.enableLogging = value;
            if (value) this.plugin.logger.enable();
            else this.plugin.logger.disable();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Copy logs")
      .setDesc("Copy the log file content to the clipboard.")
      .addButton((button) => {
        button.setButtonText("Copy").onClick(async () => {
          const logs = await this.plugin.logger.read();
          try {
            await copyToClipboard(logs);
            new Notice("Logs copied", 5000);
          } catch (err) {
            new Notice(`Failed copying logs: ${err}`, 10000);
          }
        });
      });

    new Setting(containerEl)
      .setName("Clean logs")
      .setDesc("Delete the log file content.")
      .addButton((button) => {
        button.setButtonText("Clean").onClick(async () => {
          await this.plugin.logger.clean();
        });
      });
  }
}

// Build the live-preview element placed under each commit-message
// input, INSIDE the Setting row's info column so it inherits the
// row's background (themes that draw a rounded grey zone keep the
// preview inside it). Styled as a quiet caption — italic, dimmer
// text, small top margin to break from the description.
function makePreviewElement(parent: HTMLElement): HTMLElement {
  const el = parent.createDiv({ cls: "sync2-template-preview" });
  el.style.fontSize = "0.85em";
  el.style.color = "var(--text-muted)";
  el.style.fontStyle = "italic";
  el.style.marginTop = "10px";
  el.style.userSelect = "text"; // let users copy the rendered preview
  return el;
}

