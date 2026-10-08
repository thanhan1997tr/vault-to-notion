import { App, getFrontMatterInfo, TFile } from "obsidian";
import { FORMAT_VERSION, toNotionMarkdown } from "markdown";
import { Json, NotionApi, NotionError, parseNotionId } from "notion-api";
import type { PluginSettings } from "settings";

export const FM_ID = "notion_id";
export const FM_URL = "notion_url";

const MAX_OPTION_LENGTH = 100;

export type PublishStatus = "created" | "updated" | "unchanged";

export interface PublishResult {
	url: string;
	status: PublishStatus;
}

export type ProgressFn = (message: string) => void;

/** What the plugin remembers between runs; persisted in the plugin's data.json. */
export interface SyncState {
	/** Content fingerprints of published notes, keyed by Notion page ID (without dashes). */
	fingerprints: Record<string, string>;
	/** Vault folder path → its folder page in Notion. */
	folderPages: Record<string, string>;
	/** Vault folder path → the page holding that folder's note table ("/" is the root page). */
	folderViews: Record<string, string>;
	/** The root page that `folderPages` were created under. */
	folderRoot: string;
}

/** Page tree: every note is a page under the page of its folder, mirroring the vault. */
interface PagesTarget {
	mode: "pages";
	name: string;
	rootPageId: string;
}

/** Database: every note is a row; folder pages with filtered tables are optional. */
interface DatabaseTarget {
	mode: "database";
	name: string;
	dataSourceId: string;
	titleName: string;
	folderName?: string;
	folderType?: "select" | "rich_text";
	rootPageId?: string;
}

export type Target = PagesTarget | DatabaseTarget;

/**
 * Publishes notes to Notion. One instance can publish many notes; the destination is resolved
 * once, and lookups are cached for the run.
 */
export class Publisher {
	private readonly api: NotionApi;
	private target?: Promise<Target>;
	/** Pages that currently exist in the data source (database mode). */
	private livePageIds?: Promise<Set<string>>;
	/** Child pages of each folder page (page tree mode). */
	private readonly childPageIds = new Map<string, Promise<Set<string>>>();
	/** Folder pages and note tables already checked or created during this run. */
	private readonly folderPageCache = new Map<string, Promise<string>>();
	private readonly folderViewCache = new Map<string, Promise<void>>();

	constructor(
		private readonly app: App,
		private readonly settings: PluginSettings,
		private readonly state: SyncState,
	) {
		this.api = new NotionApi(settings.token);
	}

	/** Checks the token and the destination. Safe to call more than once. */
	prepare(): Promise<Target> {
		this.target ??= this.settings.mode === "pages" ? this.resolvePagesTarget() : this.resolveDatabaseTarget();
		this.target.catch(() => (this.target = undefined));
		return this.target;
	}

	/**
	 * Creates or updates the note's page. With `skipUnchanged`, a note whose content, title
	 * and location match the last publish is left alone, provided its page still exists.
	 */
	async publish(file: TFile, progress: ProgressFn, skipUnchanged = false): Promise<PublishResult> {
		const target = await this.prepare();
		const folder = folderPath(file);
		if (target.mode === "pages") {
			const parentId = await this.ensureFolderPage(folder, target.rootPageId, progress);
			return this.publishNote(file, target, parentId, progress, skipUnchanged);
		}

		const result = await this.publishNote(file, target, target.dataSourceId, progress, skipUnchanged);
		// After the note is written: the table filters on the note's folder, which Notion only
		// accepts once that folder exists as a select option. Unchanged notes get it too.
		if (target.rootPageId) await this.ensureFolderView(folder, target, progress);
		return result;
	}

	/** `parentId` is the folder page (page tree) or the data source (database). */
	private async publishNote(
		file: TFile,
		target: Target,
		parentId: string,
		progress: ProgressFn,
		skipUnchanged: boolean,
	): Promise<PublishResult> {
		const content = await this.app.vault.read(file);
		const body = content.slice(getFrontMatterInfo(content).contentStart);
		const properties = this.buildProperties(file, target);
		const cover = this.settings.coverUrl
			? { type: "external", external: { url: this.settings.coverUrl } }
			: undefined;

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const existingId = parseNotionId(String(frontmatter?.[FM_ID] ?? ""));
		const fingerprint = await sha256(
			JSON.stringify([FORMAT_VERSION, target.mode, parentId, properties, cover ?? null, body]),
		);
		if (
			skipUnchanged &&
			existingId &&
			this.state.fingerprints[existingId] === fingerprint &&
			// A page deleted in Notion must be recreated even though the note did not change.
			(await this.pagesUnder(parentId, target)).has(existingId)
		) {
			return { url: String(frontmatter?.[FM_URL] ?? ""), status: "unchanged" };
		}

		const markdown = toNotionMarkdown(body);
		const existing = existingId ? await this.findPage(existingId, target, parentId, progress) : null;
		if (existingId && !existing) delete this.state.fingerprints[existingId];

		let page: Json;
		if (existing) {
			progress("Updating page…");
			page = await this.api.updatePage(existing.id, { properties, cover });
			progress("Replacing content…");
			await this.api.replaceContent(page.id, markdown || "<empty-block/>");
		} else {
			progress("Creating page…");
			page = await this.api.createPage({
				parent:
					target.mode === "pages"
						? { type: "page_id", page_id: parentId }
						: { type: "data_source_id", data_source_id: parentId },
				properties,
				cover,
				markdown: markdown || undefined,
			});
		}

		// `public_url` is set when the page is published to the web; links are not stable IDs.
		const url: string = page.public_url ?? page.url;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FM_ID] = page.id;
			fm[FM_URL] = url;
		});
		this.state.fingerprints[parseNotionId(page.id) ?? page.id] = fingerprint;
		return { url, status: existing ? "updated" : "created" };
	}

	/** IDs of the pages currently under `parentId`, fetched once per run. */
	private pagesUnder(parentId: string, target: Target): Promise<Set<string>> {
		if (target.mode === "database") {
			this.livePageIds ??= this.api.listPageIds(parentId);
			this.livePageIds.catch(() => (this.livePageIds = undefined));
			return this.livePageIds;
		}
		let ids = this.childPageIds.get(parentId);
		if (!ids) {
			ids = this.api.listChildPageIds(parentId);
			ids.catch(() => this.childPageIds.delete(parentId));
			this.childPageIds.set(parentId, ids);
		}
		return ids;
	}

	/**
	 * Returns the note's existing page if it can be updated in place, or null when a new page
	 * is needed (deleted, in the trash, or created by the other mode). In page tree mode, a page
	 * found under another folder page is moved, so notes moved in the vault keep their link.
	 */
	private async findPage(pageId: string, target: Target, parentId: string, progress: ProgressFn): Promise<Json | null> {
		let page: Json;
		try {
			page = await this.api.getPage(pageId);
		} catch (err) {
			if (err instanceof NotionError && err.status === 404) return null;
			throw err;
		}
		if (page.in_trash) return null;

		if (target.mode === "database") {
			return parseNotionId(page.parent?.data_source_id ?? "") === parseNotionId(parentId) ? page : null;
		}
		if (page.parent?.type !== "page_id") return null;
		if (parseNotionId(page.parent.page_id) !== parseNotionId(parentId)) {
			progress("Moving page to its folder…");
			await this.api.movePage(page.id, parentId);
		}
		return page;
	}

	private async resolvePagesTarget(): Promise<PagesTarget> {
		const root = await this.resolveRootPage();
		if (!root) throw new Error("Set the root page in settings: the Notion page your vault is published under.");
		return { mode: "pages", name: root.name, rootPageId: root.id };
	}

	/**
	 * Resolves the configured link to a data source. Accepts a database link or ID (the
	 * database must have exactly one data source) or a data source ID.
	 * @see https://developers.notion.com/docs/upgrade-guide-2025-09-03
	 */
	private async resolveDatabaseTarget(): Promise<DatabaseTarget> {
		const id = parseNotionId(this.settings.database);
		if (!id) throw new Error("The database link in settings is not valid.");

		let dataSource: Json;
		try {
			const database = await this.api.getDatabase(id);
			const sources: Json[] = database.data_sources ?? [];
			if (sources.length !== 1) {
				throw new Error(
					`This database has ${sources.length} data sources. In Notion, open the database's ••• menu → ` +
						"Manage data sources → Copy data source ID, and paste that ID in settings instead.",
				);
			}
			dataSource = await this.api.getDataSource(sources[0].id);
		} catch (err) {
			if (!(err instanceof NotionError) || (err.status !== 404 && err.status !== 400)) throw err;
			if (/is a page, not a database/i.test(err.message)) {
				throw new Error(
					"This link is a page, not a database. Paste a database link here (open the database → ••• → Copy link), " +
						'or switch "Publish as" to Page tree.',
				);
			}
			dataSource = await this.api.getDataSource(id).catch(() => {
				throw new Error(
					`Notion could not find this database. In Notion, open the database → ••• → Connections → ` +
						`+ Add connection → ${connectionName(err)}. Use the original database, not a linked view.`,
				);
			});
		}

		const columns: Record<string, Json> = dataSource.properties;
		const titleName = Object.keys(columns).find((name) => columns[name].type === "title");
		if (!titleName) throw new Error("The Notion database has no title column.");

		const tagsName = this.tagsColumn();
		if (tagsName && columns[tagsName]?.type !== "multi_select") {
			throw new Error(`The database needs a multi-select column named "${tagsName}" to sync tags.`);
		}

		const folderName = this.folderColumn();
		const folderType = folderName ? columns[folderName]?.type : undefined;
		if (folderName && folderType !== "select" && folderType !== "rich_text") {
			throw new Error(`The database needs a select or text column named "${folderName}" to sync folders.`);
		}

		const root = await this.resolveRootPage();
		if (root && !folderName) throw new Error('Folder pages need "Sync folder" to be turned on.');

		const name = plainText(dataSource.title) || "Untitled";
		return { mode: "database", name, dataSourceId: dataSource.id, titleName, folderName, folderType, rootPageId: root?.id };
	}

	/** Checks the root page the folder tree is built under, if one is set. */
	private async resolveRootPage(): Promise<{ id: string; name: string } | undefined> {
		const input = this.settings.rootPage.trim();
		if (!input) return undefined;

		const id = parseNotionId(input);
		if (!id) throw new Error("The root page link in settings is not valid.");
		const root = await this.api.getPage(id).catch((err) => {
			if (!(err instanceof NotionError) || (err.status !== 404 && err.status !== 400)) throw err;
			throw new Error(
				"Notion could not find the root page. It must be a page (not a database) that your connection can " +
					`access: open it → ••• → Connections → + Add connection → ${connectionName(err)}.`,
			);
		});
		if (root.in_trash) throw new Error("The root page is in the Notion trash.");

		// Folder pages built under a different root are no longer relevant.
		const rootId = parseNotionId(root.id) as string;
		if (this.state.folderRoot !== rootId) {
			this.state.folderPages = {};
			this.state.folderViews = {};
			this.state.folderRoot = rootId;
		}
		const titleProperty = Object.values(root.properties ?? {}).find((p: Json) => p.type === "title") as Json;
		return { id: rootId, name: plainText(titleProperty?.title) || "Untitled" };
	}

	/**
	 * Returns the page for a vault folder, creating it and its parents under the root page when
	 * missing. "/" (the vault root) is the root page itself. Results, including failures, are
	 * cached for the run so one broken folder does not repeat its API calls for every note.
	 */
	private ensureFolderPage(path: string, rootPageId: string, progress: ProgressFn): Promise<string> {
		let page = this.folderPageCache.get(path);
		if (!page) {
			page = this.createFolderPageIfMissing(path, rootPageId, progress);
			this.folderPageCache.set(path, page);
		}
		return page;
	}

	private async createFolderPageIfMissing(path: string, rootPageId: string, progress: ProgressFn): Promise<string> {
		if (path === "/") return rootPageId;
		const known = this.state.folderPages[path];
		if (known && (await this.isLivePage(known))) return known;
		delete this.state.folderPages[path];

		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
		const parentId = await this.ensureFolderPage(parentPath, rootPageId, progress);
		progress(`Creating folder page "${path}"…`);
		const page = await this.api.createPage({
			parent: { type: "page_id", page_id: parentId },
			icon: { type: "emoji", emoji: "📁" },
			properties: { title: { title: [{ type: "text", text: { content: path.slice(path.lastIndexOf("/") + 1) } }] } },
		});
		this.state.folderPages[path] = page.id;
		return page.id;
	}

	/**
	 * Database mode: adds a table of the folder's notes (a linked view of the database, filtered
	 * to the folder) to its folder page. Only folders that directly contain notes get one.
	 */
	private ensureFolderView(path: string, target: DatabaseTarget, progress: ProgressFn): Promise<void> {
		let view = this.folderViewCache.get(path);
		if (!view) {
			view = this.createFolderViewIfMissing(path, target, progress);
			this.folderViewCache.set(path, view);
		}
		return view;
	}

	private async createFolderViewIfMissing(path: string, target: DatabaseTarget, progress: ProgressFn): Promise<void> {
		const pageId = await this.ensureFolderPage(path, target.rootPageId as string, progress);
		if (this.state.folderViews[path] === pageId) return;

		progress(`Adding the note table to "${path}"…`);
		await this.api.createView({
			create_database: { parent: { type: "page_id", page_id: pageId } },
			data_source_id: target.dataSourceId,
			name: path === "/" ? target.name : path.slice(path.lastIndexOf("/") + 1),
			type: "table",
			filter:
				target.folderType === "select"
					? { property: target.folderName, select: { equals: toOptionName(path) } }
					: { property: target.folderName, rich_text: { equals: path } },
		});
		this.state.folderViews[path] = pageId;
	}

	private async isLivePage(pageId: string): Promise<boolean> {
		try {
			return !(await this.api.getPage(pageId)).in_trash;
		} catch (err) {
			if (err instanceof NotionError && err.status === 404) return false;
			throw err;
		}
	}

	private tagsColumn(): string {
		return this.settings.syncTags ? this.settings.tagsProperty.trim() : "";
	}

	private folderColumn(): string {
		return this.settings.syncFolder ? this.settings.folderProperty.trim() : "";
	}

	private buildProperties(file: TFile, target: Target): Json {
		const title = [{ type: "text", text: { content: file.basename } }];
		// Pages outside a database only have a title.
		if (target.mode === "pages") return { title: { title } };

		const properties: Json = { [target.titleName]: { title } };
		const tagsName = this.tagsColumn();
		if (tagsName) properties[tagsName] = { multi_select: this.readTags(file).map((name) => ({ name })) };

		if (target.folderName) {
			const folder = folderPath(file);
			properties[target.folderName] =
				target.folderType === "select"
					? { select: { name: toOptionName(folder) } }
					: { rich_text: [{ type: "text", text: { content: folder } }] };
		}
		return properties;
	}

	private readTags(file: TFile): string[] {
		const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
		const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
		const tags = list.map((tag) => toOptionName(String(tag ?? "").replace(/^#/, ""))).filter(Boolean);
		return [...new Set(tags)];
	}
}

/** The note's folder as Obsidian names it; "/" is the vault root. */
function folderPath(file: TFile): string {
	return file.parent?.path ?? "/";
}

/** Notion's "not found" messages name the connection, which is what the user has to look for. */
function connectionName(err: Error): string {
	const name = err.message.match(/integration "([^"]+)"/)?.[1];
	return name ? `"${name}"` : "your connection";
}

function plainText(richText: Json[] | undefined): string {
	return (richText ?? []).map((t: Json) => t.plain_text).join("");
}

/** Select option names cannot contain commas and are capped at 100 characters. */
function toOptionName(value: string): string {
	const name = value.replace(/,/g, " ").trim();
	return name.length > MAX_OPTION_LENGTH ? "…" + name.slice(-(MAX_OPTION_LENGTH - 1)) : name;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
