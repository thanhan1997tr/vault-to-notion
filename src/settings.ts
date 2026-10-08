import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultToNotionPlugin from "main";
import { Publisher } from "publisher";

export type PublishMode = "pages" | "database";

export interface PluginSettings {
	mode: PublishMode;
	token: string;
	/** Page tree: the page the vault is published under. Database: optional folder pages root. */
	rootPage: string;
	database: string;
	syncTags: boolean;
	tagsProperty: string;
	syncFolder: boolean;
	folderProperty: string;
	coverUrl: string;
	copyLink: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	mode: "pages",
	token: "",
	rootPage: "",
	database: "",
	syncTags: false,
	tagsProperty: "Tags",
	syncFolder: false,
	folderProperty: "Folder",
	coverUrl: "",
	copyLink: true,
};

const ACCESS_HINT = "With an internal connection, give it access: ••• → Connections → + Add connection.";

export class SettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VaultToNotionPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName("API token")
			.setDesc("An internal connection token (app.notion.com/developers/connections → Configuration) or a personal access token.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("ntn_…")
					.setValue(settings.token)
					.onChange(async (value) => {
						settings.token = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Publish as")
			.setDesc(
				settings.mode === "pages"
					? "Page tree: folders and notes become pages in the Notion sidebar, like your vault."
					: "Database: notes become rows of a database you can filter and sort.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("pages", "Page tree")
					.addOption("database", "Database")
					.setValue(settings.mode)
					.onChange(async (value) => {
						settings.mode = value as PublishMode;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (settings.mode === "pages") {
			this.addLinkSetting(
				"Root page",
				`The Notion page your vault is published under (••• → Copy link). ${ACCESS_HINT}`,
				"rootPage",
			);
		} else {
			this.addLinkSetting(
				"Database",
				`The database link (••• → Copy link) or a data source ID. ${ACCESS_HINT}`,
				"database",
			);
		}

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Checks the token and that Notion can find what you linked above.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					try {
						new Notice(await testConnection(this.app, settings));
					} finally {
						button.setDisabled(false);
					}
				}),
			);

		if (settings.mode === "database") this.displayDatabaseSettings();

		new Setting(containerEl).setName("Publishing").setHeading();

		new Setting(containerEl)
			.setName("Cover image URL")
			.setDesc("Optional. An image URL used as the cover of every published page.")
			.addText((text) =>
				text
					.setPlaceholder("https://…")
					.setValue(settings.coverUrl)
					.onChange(async (value) => {
						settings.coverUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Copy link after publishing").addToggle((toggle) =>
			toggle.setValue(settings.copyLink).onChange(async (value) => {
				settings.copyLink = value;
				await this.plugin.saveSettings();
			}),
		);
	}

	private displayDatabaseSettings(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;

		new Setting(containerEl).setName("Columns").setHeading();

		new Setting(containerEl)
			.setName("Sync tags")
			.setDesc("Copy the note's frontmatter tags into a multi-select column.")
			.addToggle((toggle) =>
				toggle.setValue(settings.syncTags).onChange(async (value) => {
					settings.syncTags = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Tags column")
			.setDesc("Name of the multi-select column that receives the tags.")
			.addText((text) =>
				text.setValue(settings.tagsProperty).onChange(async (value) => {
					settings.tagsProperty = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc("Write the note's folder path into a select or text column, to group pages by folder.")
			.addToggle((toggle) =>
				toggle.setValue(settings.syncFolder).onChange(async (value) => {
					settings.syncFolder = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Folder column")
			.setDesc("Name of the select or text column that receives the folder path.")
			.addText((text) =>
				text.setValue(settings.folderProperty).onChange(async (value) => {
					settings.folderProperty = value;
					await this.plugin.saveSettings();
				}),
			);

		this.addLinkSetting(
			"Folder pages",
			"Optional. A Notion page under which your folder tree is built, each folder showing a table of its " +
				"notes. Requires Sync folder.",
			"rootPage",
		);
	}

	private addLinkSetting(name: string, desc: string, key: "rootPage" | "database"): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder("https://app.notion.com/p/…")
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value.trim();
						await this.plugin.saveSettings();
					}),
			);
	}
}

async function testConnection(app: App, settings: PluginSettings): Promise<string> {
	if (!settings.token) return "Enter an API token first.";
	try {
		const state = { fingerprints: {}, folderPages: {}, folderViews: {}, folderRoot: "" };
		const target = await new Publisher(app, settings, state).prepare();
		return `Connected to "${target.name}".`;
	} catch (err) {
		return `Connection failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}
