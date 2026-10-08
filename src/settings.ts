import { App, Notice, PluginSettingTab, SecretComponent, SettingDefinitionItem } from "obsidian";
import type VaultToNotionPlugin from "main";
import { Publisher } from "publisher";

export type PublishMode = "pages" | "database";

export interface PluginSettings {
	mode: PublishMode;
	/** Name of the secret in Obsidian's secret storage that holds the Notion token. */
	tokenSecret: string;
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
	tokenSecret: "",
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

	/** @see https://docs.obsidian.md/Plugins/User+interface/Settings */
	getSettingDefinitions(): SettingDefinitionItem<keyof PluginSettings>[] {
		const settings = this.plugin.settings;
		const isDatabase = () => settings.mode === "database";

		return [
			{
				name: "API token",
				desc:
					"Your Notion internal connection token or personal access token, kept in Obsidian's secret " +
					"storage rather than in plugin data. Pick a saved secret or create one.",
				aliases: ["notion token", "secret", "integration"],
				// Secrets have no declarative control yet, so this row is rendered by hand.
				render: (setting) => {
					setting.addComponent((el) =>
						new SecretComponent(this.app, el).setValue(settings.tokenSecret).onChange(async (name) => {
							settings.tokenSecret = name;
							await this.plugin.saveSettings();
						}),
					);
				},
			},
			{
				name: "Publish as",
				desc: "Page tree: folders and notes become pages in the Notion sidebar. Database: notes become rows you can filter and sort.",
				control: { type: "dropdown", key: "mode", options: { pages: "Page tree", database: "Database" } },
			},
			{
				name: "Root page",
				desc: `The Notion page your vault is published under (••• → Copy link). ${ACCESS_HINT}`,
				visible: () => !isDatabase(),
				control: { type: "text", key: "rootPage", placeholder: "Paste a Notion link" },
			},
			{
				name: "Database",
				desc: `The database link (••• → Copy link) or a data source ID. ${ACCESS_HINT}`,
				visible: isDatabase,
				control: { type: "text", key: "database", placeholder: "Paste a Notion link" },
			},
			{
				name: "Test connection",
				desc: "Checks the token and that Notion can find what you linked above.",
				searchable: false,
				render: (setting) => {
					setting.addButton((button) =>
						button.setButtonText("Test").onClick(async () => {
							button.setDisabled(true);
							try {
								new Notice(await testConnection(this.app, settings));
							} finally {
								button.setDisabled(false);
							}
						}),
					);
				},
			},
			{
				type: "group",
				heading: "Columns",
				visible: isDatabase,
				items: [
					{
						name: "Sync tags",
						desc: "Copy the note's frontmatter tags into a multi-select column.",
						control: { type: "toggle", key: "syncTags" },
					},
					{
						name: "Tags column",
						desc: "Name of the multi-select column that receives the tags.",
						control: { type: "text", key: "tagsProperty" },
					},
					{
						name: "Sync folder",
						desc: "Write the note's folder path into a select or text column, to group pages by folder.",
						control: { type: "toggle", key: "syncFolder" },
					},
					{
						name: "Folder column",
						desc: "Name of the select or text column that receives the folder path.",
						control: { type: "text", key: "folderProperty" },
					},
					{
						name: "Folder pages",
						desc:
							"Optional. A Notion page under which your folder tree is built, each folder showing a table " +
							"of its notes. Requires Sync folder.",
						control: { type: "text", key: "rootPage", placeholder: "Paste a Notion link" },
					},
				],
			},
			{
				type: "group",
				heading: "Publishing",
				items: [
					{
						name: "Cover image URL",
						desc: "Optional. An image URL used as the cover of every published page.",
						control: { type: "text", key: "coverUrl", placeholder: "Image link" },
					},
					{
						name: "Copy link after publishing",
						control: { type: "toggle", key: "copyLink" },
					},
				],
			},
		];
	}

	/**
	 * The default implementation saves only the settings object; this plugin stores its sync
	 * state in the same data file, so saving goes through the plugin.
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.plugin.settings, { [key]: value });
		await this.plugin.saveSettings();
	}
}

async function testConnection(app: App, settings: PluginSettings): Promise<string> {
	if (!readToken(app, settings)) return "Choose the secret that holds your Notion API token first.";
	try {
		const state = { fingerprints: {}, folderPages: {}, folderViews: {}, folderRoot: "" };
		const target = await new Publisher(app, settings, state).prepare();
		return `Connected to "${target.name}".`;
	} catch (err) {
		return `Connection failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** The Notion token from Obsidian's secret storage, or "" when none is set. */
export function readToken(app: App, settings: PluginSettings): string {
	return (settings.tokenSecret && app.secretStorage.getSecret(settings.tokenSecret)) || "";
}
