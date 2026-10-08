import { MarkdownView, Notice, Plugin, TFile, TFolder } from "obsidian";
import { ICON_ID, registerIcons } from "icons";
import { confirm, FolderSuggestModal } from "modals";
import { NotionError } from "notion-api";
import { FM_URL, PublishStatus, Publisher, SyncState } from "publisher";
import { DEFAULT_SETTINGS, PluginSettings, SettingsTab } from "settings";

/** Ask before publishing a folder with more notes than this. */
const CONFIRM_THRESHOLD = 20;

export default class VaultToNotionPlugin extends Plugin {
	settings!: PluginSettings;
	private state: SyncState = { fingerprints: {}, folderPages: {}, folderViews: {}, folderRoot: "" };
	private readonly inFlight = new Set<string>();
	private folderRunning = false;

	async onload() {
		await this.loadSettings();
		registerIcons();

		this.addRibbonIcon(ICON_ID, "Publish to Notion", () => {
			const file = this.app.workspace.getActiveFile();
			if (file?.extension === "md") this.publish(file);
			else new Notice("Open a note to publish it to Notion.");
		});

		this.addCommand({
			id: "publish-current-note",
			name: "Publish current note",
			icon: ICON_ID,
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return false;
				if (!checking) this.publish(file);
				return true;
			},
		});

		this.addCommand({
			id: "publish-folder",
			name: "Publish folder…",
			icon: ICON_ID,
			callback: () => new FolderSuggestModal(this.app, (folder) => this.publishFolder(folder)).open(),
		});

		this.addCommand({
			id: "open-in-notion",
			name: "Open current note in Notion",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const url = file && this.app.metadataCache.getFileCache(file)?.frontmatter?.[FM_URL];
				if (typeof url !== "string") return false;
				if (!checking) window.open(url);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("Publish folder to Notion")
							.setIcon(ICON_ID)
							.onClick(() => this.publishFolder(file)),
					);
				} else if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle("Publish to Notion")
							.setIcon(ICON_ID)
							.onClick(() => this.publish(file)),
					);
				}
			}),
		);

		this.addSettingTab(new SettingsTab(this.app, this));
	}

	async publish(file: TFile) {
		if (!this.checkConfigured()) return;
		if (this.inFlight.has(file.path)) {
			new Notice(`"${file.basename}" is already being published.`);
			return;
		}

		this.inFlight.add(file.path);
		const notice = new Notice(`Publishing "${file.basename}"…`, 0);
		try {
			const publisher = new Publisher(this.app, this.settings, this.state);
			const { url, status } = await publisher.publish(file, (message) => notice.setMessage(message));
			let copied = false;
			if (this.settings.copyLink) {
				copied = await navigator.clipboard.writeText(url).then(
					() => true,
					() => false,
				);
			}
			notice.hide();
			const verb = status === "created" ? "Published" : "Updated";
			new Notice(`${verb} "${file.basename}" on Notion.${copied ? " Link copied." : ""}`);
		} catch (err) {
			notice.hide();
			console.error("[Vault to Notion]", err);
			new Notice(`Could not publish "${file.basename}": ${errorMessage(err)}`, 10000);
		} finally {
			this.inFlight.delete(file.path);
			await this.saveSettings();
		}
	}

	/** Publishes every note under the folder, skipping notes unchanged since their last publish. */
	async publishFolder(folder: TFolder) {
		if (!this.checkConfigured()) return;
		if (this.folderRunning) {
			new Notice("A folder is already being published. Wait for it to finish.");
			return;
		}

		const prefix = folder.isRoot() ? "" : folder.path + "/";
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(prefix))
			.sort((a, b) => compareVaultOrder(a.path, b.path));
		const label = folder.isRoot() ? "the vault" : `"${folder.path}"`;

		if (files.length === 0) {
			new Notice(`There are no notes in ${label}.`);
			return;
		}
		if (
			files.length > CONFIRM_THRESHOLD &&
			!(await confirm(
				this.app,
				"Publish folder to Notion",
				`Publish ${files.length} notes from ${label}? Notes that have not changed since their last publish are skipped.`,
				"Publish",
			))
		) {
			return;
		}

		this.folderRunning = true;
		const notice = new Notice(`Publishing ${label}…`, 0);
		const counts: Record<PublishStatus, number> = { created: 0, updated: 0, unchanged: 0 };
		const failed: { file: TFile; error: string }[] = [];
		const publisher = new Publisher(this.app, this.settings, this.state);

		try {
			await publisher.prepare();

			for (const [i, file] of files.entries()) {
				const step = `Publishing ${label} — ${i + 1}/${files.length}`;
				notice.setMessage(`${step}\n${file.basename}`);
				if (this.inFlight.has(file.path)) {
					failed.push({ file, error: "it was already being published" });
					continue;
				}

				this.inFlight.add(file.path);
				try {
					const { status } = await publisher.publish(
						file,
						(message) => notice.setMessage(`${step}\n${file.basename}: ${message}`),
						true,
					);
					counts[status]++;
				} catch (err) {
					// A rejected token will fail every remaining note too, so stop here.
					if (err instanceof NotionError && (err.status === 401 || err.status === 403)) throw err;
					console.error(`[Vault to Notion] ${file.path}`, err);
					failed.push({ file, error: errorMessage(err) });
				} finally {
					this.inFlight.delete(file.path);
				}
			}

			notice.hide();
			const summary = [
				counts.created && `${counts.created} created`,
				counts.updated && `${counts.updated} updated`,
				counts.unchanged && `${counts.unchanged} unchanged`,
				failed.length && `${failed.length} failed`,
			]
				.filter(Boolean)
				.join(", ");
			const failures = failed
				.slice(0, 5)
				.map(({ file, error }) => `\n• ${file.basename}: ${error}`)
				.join("");
			const more = failed.length > 5 ? `\n…and ${failed.length - 5} more (see the developer console).` : "";
			new Notice(`Published ${label}: ${summary}.${failures}${more}`, failed.length ? 0 : 8000);
		} catch (err) {
			notice.hide();
			console.error("[Vault to Notion]", err);
			new Notice(`Stopped publishing ${label}: ${errorMessage(err)}`, 10000);
		} finally {
			this.folderRunning = false;
			await this.saveSettings();
		}
	}

	private checkConfigured(): boolean {
		const { token, mode, rootPage, database } = this.settings;
		if (token && (mode === "pages" ? rootPage : database)) return true;
		const what = mode === "pages" ? "root page" : "database";
		new Notice(`Set the Notion API token and ${what} in the Vault to Notion settings.`);
		return false;
	}

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		this.state = {
			fingerprints: data.fingerprints ?? {},
			folderPages: data.folderPages ?? {},
			folderViews: data.folderViews ?? {},
			folderRoot: data.folderRoot ?? "",
		};
		// Only known keys, so settings removed in later versions do not linger in data.json.
		const settings = { ...DEFAULT_SETTINGS };
		for (const key of Object.keys(settings) as (keyof PluginSettings)[]) {
			if (data[key] !== undefined) Object.assign(settings, { [key]: data[key] });
		}
		// Before 1.0.0 there was only the database mode, and its root page was "folderPagesRoot".
		if (data.mode === undefined && data.database) settings.mode = "database";
		if (data.rootPage === undefined && data.folderPagesRoot) settings.rootPage = data.folderPagesRoot;
		this.settings = settings;
	}

	async saveSettings() {
		await this.saveData({ ...this.settings, ...this.state });
	}
}

/**
 * Orders paths the way Obsidian's file explorer does: within a folder, subfolders come before
 * notes. Publishing in this order creates folder pages before the notes beside them.
 */
function compareVaultOrder(a: string, b: string): number {
	const pa = a.split("/");
	const pb = b.split("/");
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		if (pa[i] === pb[i]) continue;
		const aIsNote = i === pa.length - 1;
		const bIsNote = i === pb.length - 1;
		if (aIsNote !== bIsNote) return aIsNote ? 1 : -1;
		return pa[i].localeCompare(pb[i]);
	}
	return pa.length - pb.length;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
