import { requestUrl, RequestUrlResponse } from "obsidian";

const API_BASE = "https://api.notion.com/v1";
/** @see https://developers.notion.com/reference/versioning */
const API_VERSION = "2026-03-11";
const MAX_ATTEMPTS = 5;
const MAX_RETRY_WAIT_MS = 60_000;
const ASYNC_TASK_TIMEOUT_MS = 10 * 60_000;

// The shapes below describe only the fields this plugin reads; Notion returns many more.

export interface RichText {
	plain_text: string;
}

export interface PageParent {
	type: string;
	page_id?: string;
	database_id?: string;
	data_source_id?: string;
}

export interface Page {
	object: "page";
	id: string;
	url: string;
	public_url?: string | null;
	in_trash?: boolean;
	parent?: PageParent;
	properties?: Record<string, { type: string; title?: RichText[] }>;
}

export interface Database {
	data_sources?: { id: string; name: string }[];
}

export interface DataSource {
	id: string;
	title?: RichText[];
	properties: Record<string, { type: string }>;
}

interface List<T> {
	results?: T[];
	has_more?: boolean;
	next_cursor?: string | null;
}

interface ApiError {
	status?: number;
	code?: string;
	message?: string;
	additional_data?: { rate_limit_reason?: string; retry_after?: string };
}

/** @see https://developers.notion.com/reference/retrieve-async-task */
interface AsyncTask {
	object: "async_task";
	id: string;
	status: "queued" | "running" | "retrying" | "succeeded" | "failed";
	poll_after_seconds?: number;
	result?: { object?: string; id: string };
	error?: ApiError;
}

/** A request body: Notion's create/update payloads are built ad hoc by the caller. */
export type Body = Record<string, unknown>;

export class NotionError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "NotionError";
	}
}

/** Accepts a raw ID (with or without dashes) or any Notion URL containing one. */
export function parseNotionId(input: string): string | null {
	const match = input.replace(/-/g, "").match(/[0-9a-f]{32}/i);
	return match ? match[0].toLowerCase() : null;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const normalizeId = (id: string) => id.replace(/-/g, "").toLowerCase();

export class NotionApi {
	constructor(private readonly token: string) {}

	getDatabase(databaseId: string): Promise<Database> {
		return this.request<Database>("GET", `/databases/${databaseId}`);
	}

	getDataSource(dataSourceId: string): Promise<DataSource> {
		return this.request<DataSource>("GET", `/data_sources/${dataSourceId}`);
	}

	getPage(pageId: string): Promise<Page> {
		return this.request<Page>("GET", `/pages/${pageId}`);
	}

	/** Creates a page, optionally with content given as Notion-flavoured Markdown. */
	async createPage(body: Body): Promise<Page> {
		// Notion rejects `allow_async` (even `false`) unless the request carries `markdown`.
		const payload = body.markdown === undefined ? body : { ...body, allow_async: true };
		const res = await this.request<Page | AsyncTask>("POST", "/pages", payload);
		if (res.object === "page") return res;
		// An async task returns a partial result; the page itself carries the URLs we need.
		const result = await this.waitForTask(res);
		return this.getPage(result.id);
	}

	updatePage(pageId: string, body: Body): Promise<Page> {
		return this.request<Page>("PATCH", `/pages/${pageId}`, body);
	}

	/**
	 * IDs (without dashes) of every page currently in the data source. Trashed pages are not
	 * returned. @see https://developers.notion.com/reference/query-a-data-source
	 */
	async listPageIds(dataSourceId: string): Promise<Set<string>> {
		const ids = new Set<string>();
		let cursor: string | undefined;
		do {
			const res = await this.request<List<Page>>(
				"POST",
				`/data_sources/${dataSourceId}/query?filter_properties[]=title`,
				{ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
				true,
			);
			for (const page of res.results ?? []) {
				if (page.object === "page" && !page.in_trash) ids.add(normalizeId(page.id));
			}
			cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
		} while (cursor);
		return ids;
	}

	/** IDs (without dashes) of the pages directly under a page. @see https://developers.notion.com/reference/get-block-children */
	async listChildPageIds(pageId: string): Promise<Set<string>> {
		const ids = new Set<string>();
		let cursor: string | undefined;
		do {
			const query = `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
			const res = await this.request<List<{ id: string; type: string; in_trash?: boolean }>>(
				"GET",
				`/blocks/${pageId}/children?${query}`,
			);
			for (const block of res.results ?? []) {
				if (block.type === "child_page" && !block.in_trash) ids.add(normalizeId(block.id));
			}
			cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
		} while (cursor);
		return ids;
	}

	/** @see https://developers.notion.com/reference/move-page */
	async movePage(pageId: string, parentPageId: string): Promise<void> {
		await this.request("POST", `/pages/${pageId}/move`, { parent: { type: "page_id", page_id: parentPageId } });
	}

	/** @see https://developers.notion.com/guides/data-apis/working-with-views */
	async createView(body: Body): Promise<void> {
		await this.request("POST", "/views", body);
	}

	/** Replaces the page's entire content. Fails rather than deleting child pages or databases. */
	async replaceContent(pageId: string, markdown: string): Promise<void> {
		const res = await this.request<{ object?: string } | AsyncTask>("PATCH", `/pages/${pageId}/markdown`, {
			type: "replace_content",
			replace_content: { new_str: markdown },
			allow_async: true,
		});
		if (res.object === "async_task") await this.waitForTask(res as AsyncTask);
	}

	/** Polls an async task until it finishes and returns its result. */
	private async waitForTask(task: AsyncTask): Promise<{ id: string }> {
		const deadline = Date.now() + ASYNC_TASK_TIMEOUT_MS;
		while (task.status !== "succeeded") {
			if (task.status === "failed") {
				const err = task.error ?? {};
				throw new NotionError(err.status ?? 0, err.code ?? "unknown", err.message ?? "Notion could not save the page.");
			}
			if (Date.now() > deadline) throw new Error("Notion is still processing the page. Check it in Notion later.");
			await sleep(Math.max(1, Number(task.poll_after_seconds) || 1) * 1000);
			task = await this.request<AsyncTask>("GET", `/async_tasks/${task.id}`);
		}
		if (!task.result) throw new Error("Notion finished saving the page but did not say which page it was.");
		return task.result;
	}

	/**
	 * Sends a request, retrying as Notion recommends: always on 429/529 (honouring Retry-After),
	 * and on 5xx only for idempotent requests, since a failed write may still have been saved.
	 * @see https://developers.notion.com/reference/request-limits
	 */
	private async request<T = unknown>(method: string, path: string, body?: Body, readOnly = false): Promise<T> {
		const idempotent = readOnly || method === "GET" || method === "DELETE";
		for (let attempt = 1; ; attempt++) {
			const res = await requestUrl({
				url: API_BASE + path,
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Notion-Version": API_VERSION,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				throw: false,
			});

			if (res.status < 300) return parseJson(res) as T;

			const err = (parseJson(res) ?? {}) as ApiError;
			const blocked = err.additional_data?.rate_limit_reason === "public_api_request_blocked";
			const retryable =
				((res.status === 429 && !blocked) || res.status === 529 || (idempotent && res.status >= 500)) &&
				attempt < MAX_ATTEMPTS;
			if (retryable) {
				const retryAfter = Number(res.headers["retry-after"] ?? err.additional_data?.retry_after);
				const wait = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;
				await sleep(Math.min(wait, MAX_RETRY_WAIT_MS) + Math.random() * 250);
				continue;
			}

			let message = err.message ?? `Notion API returned HTTP ${res.status}`;
			if (!idempotent && (res.status === 503 || res.status === 504)) {
				message += " The change may still have been saved; check Notion before trying again.";
			}
			throw new NotionError(res.status, err.code ?? "unknown", message);
		}
	}
}

function parseJson(res: RequestUrlResponse): unknown {
	try {
		return res.json as unknown;
	} catch {
		return null;
	}
}
