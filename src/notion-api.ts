import { requestUrl, RequestUrlResponse } from "obsidian";

const API_BASE = "https://api.notion.com/v1";
/** @see https://developers.notion.com/reference/versioning */
const API_VERSION = "2026-03-11";
const MAX_ATTEMPTS = 5;
const MAX_RETRY_WAIT_MS = 60_000;
const ASYNC_TASK_TIMEOUT_MS = 10 * 60_000;

// The Notion API is loosely typed here on purpose: we only touch a handful of fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class NotionApi {
	constructor(private readonly token: string) {}

	getDatabase(databaseId: string): Promise<Json> {
		return this.request("GET", `/databases/${databaseId}`);
	}

	getDataSource(dataSourceId: string): Promise<Json> {
		return this.request("GET", `/data_sources/${dataSourceId}`);
	}

	getPage(pageId: string): Promise<Json> {
		return this.request("GET", `/pages/${pageId}`);
	}

	/** Creates a page whose content is given as Notion-flavoured Markdown. */
	async createPage(body: Json): Promise<Json> {
		// Notion rejects `allow_async` (even `false`) unless the request carries `markdown`.
		const res = await this.request("POST", "/pages", body.markdown === undefined ? body : { ...body, allow_async: true });
		const result = res?.object === "async_task" ? await this.waitForTask(res) : res;
		// An async task may return a partial result; the page itself carries the URLs we need.
		return result?.object === "page" && result.url ? result : this.getPage(result.id);
	}

	updatePage(pageId: string, body: Json): Promise<Json> {
		return this.request("PATCH", `/pages/${pageId}`, body);
	}

	/**
	 * IDs (without dashes) of every page currently in the data source. Trashed pages are not
	 * returned. @see https://developers.notion.com/reference/query-a-data-source
	 */
	async listPageIds(dataSourceId: string): Promise<Set<string>> {
		const ids = new Set<string>();
		let cursor: string | undefined;
		do {
			const res = await this.request(
				"POST",
				`/data_sources/${dataSourceId}/query?filter_properties[]=title`,
				{ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
				true,
			);
			for (const page of res.results ?? []) {
				if (page.object === "page" && !page.in_trash) ids.add(page.id.replace(/-/g, "").toLowerCase());
			}
			cursor = res.has_more ? res.next_cursor : undefined;
		} while (cursor);
		return ids;
	}

	/** IDs (without dashes) of the pages directly under a page. @see https://developers.notion.com/reference/get-block-children */
	async listChildPageIds(pageId: string): Promise<Set<string>> {
		const ids = new Set<string>();
		let cursor: string | undefined;
		do {
			const query = `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
			const res = await this.request("GET", `/blocks/${pageId}/children?${query}`);
			for (const block of res.results ?? []) {
				if (block.type === "child_page" && !block.in_trash) ids.add(block.id.replace(/-/g, "").toLowerCase());
			}
			cursor = res.has_more ? res.next_cursor : undefined;
		} while (cursor);
		return ids;
	}

	/** @see https://developers.notion.com/reference/move-page */
	movePage(pageId: string, parentPageId: string): Promise<Json> {
		return this.request("POST", `/pages/${pageId}/move`, { parent: { type: "page_id", page_id: parentPageId } });
	}

	/** @see https://developers.notion.com/guides/data-apis/working-with-views */
	createView(body: Json): Promise<Json> {
		return this.request("POST", "/views", body);
	}

	/** Replaces the page's entire content. Fails rather than deleting child pages or databases. */
	async replaceContent(pageId: string, markdown: string): Promise<void> {
		const res = await this.request("PATCH", `/pages/${pageId}/markdown`, {
			type: "replace_content",
			replace_content: { new_str: markdown },
			allow_async: true,
		});
		if (res?.object === "async_task") await this.waitForTask(res);
	}

	/** Polls an async task until it finishes. @see https://developers.notion.com/reference/retrieve-async-task */
	private async waitForTask(task: Json): Promise<Json> {
		const deadline = Date.now() + ASYNC_TASK_TIMEOUT_MS;
		while (task.status !== "succeeded") {
			if (task.status === "failed") {
				const err = task.error ?? {};
				throw new NotionError(err.status ?? 0, err.code ?? "unknown", err.message ?? "Notion could not save the page.");
			}
			if (Date.now() > deadline) throw new Error("Notion is still processing the page. Check it in Notion later.");
			await sleep(Math.max(1, Number(task.poll_after_seconds) || 1) * 1000);
			task = await this.request("GET", `/async_tasks/${task.id}`);
		}
		return task.result;
	}

	/**
	 * Sends a request, retrying as Notion recommends: always on 429/529 (honouring Retry-After),
	 * and on 5xx only for idempotent requests, since a failed write may still have been saved.
	 * @see https://developers.notion.com/reference/request-limits
	 */
	private async request(method: string, path: string, body?: Json, readOnly = false): Promise<Json> {
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

			if (res.status < 300) return safeJson(res);

			const err = safeJson(res);
			const blocked = err?.additional_data?.rate_limit_reason === "public_api_request_blocked";
			const retryable =
				((res.status === 429 && !blocked) || res.status === 529 || (idempotent && res.status >= 500)) &&
				attempt < MAX_ATTEMPTS;
			if (retryable) {
				const retryAfter = Number(res.headers["retry-after"] ?? err?.additional_data?.retry_after);
				const wait = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;
				await sleep(Math.min(wait, MAX_RETRY_WAIT_MS) + Math.random() * 250);
				continue;
			}

			let message = err?.message ?? `Notion API returned HTTP ${res.status}`;
			if (!idempotent && (res.status === 503 || res.status === 504)) {
				message += " The change may still have been saved; check Notion before trying again.";
			}
			throw new NotionError(res.status, err?.code ?? "unknown", message);
		}
	}
}

function safeJson(res: RequestUrlResponse): Json {
	try {
		return res.json;
	} catch {
		return null;
	}
}
