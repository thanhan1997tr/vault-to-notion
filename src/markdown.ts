/**
 * Converts Obsidian-flavoured Markdown into Notion-flavoured ("enhanced") Markdown, the format
 * accepted by the Notion markdown content API.
 * @see https://developers.notion.com/guides/data-apis/enhanced-markdown
 */

/** Bump when the conversion output changes, so previously published notes are republished. */
export const FORMAT_VERSION = 1;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|avif|heic|tiff?)$/i;
/** HTML tags Notion understands; any other `<` is escaped so it is shown as text. */
const ALLOWED_TAGS = /^<\/?(br|span|details|summary)\b/i;

const CALLOUT_STYLES: Record<string, { emoji: string; color: string }> = {
	note: { emoji: "📝", color: "blue_bg" },
	info: { emoji: "ℹ️", color: "blue_bg" },
	todo: { emoji: "☑️", color: "blue_bg" },
	abstract: { emoji: "📄", color: "gray_bg" },
	summary: { emoji: "📄", color: "gray_bg" },
	tldr: { emoji: "📄", color: "gray_bg" },
	tip: { emoji: "💡", color: "green_bg" },
	hint: { emoji: "💡", color: "green_bg" },
	important: { emoji: "💡", color: "green_bg" },
	success: { emoji: "✅", color: "green_bg" },
	check: { emoji: "✅", color: "green_bg" },
	done: { emoji: "✅", color: "green_bg" },
	question: { emoji: "❓", color: "yellow_bg" },
	help: { emoji: "❓", color: "yellow_bg" },
	faq: { emoji: "❓", color: "yellow_bg" },
	warning: { emoji: "⚠️", color: "yellow_bg" },
	caution: { emoji: "⚠️", color: "yellow_bg" },
	attention: { emoji: "⚠️", color: "yellow_bg" },
	failure: { emoji: "❌", color: "red_bg" },
	fail: { emoji: "❌", color: "red_bg" },
	missing: { emoji: "❌", color: "red_bg" },
	danger: { emoji: "⛔", color: "red_bg" },
	error: { emoji: "⛔", color: "red_bg" },
	bug: { emoji: "🐛", color: "red_bg" },
	example: { emoji: "📋", color: "purple_bg" },
	quote: { emoji: "💬", color: "gray_bg" },
	cite: { emoji: "💬", color: "gray_bg" },
};
const DEFAULT_CALLOUT = { emoji: "📌", color: "gray_bg" };

export function toNotionMarkdown(body: string): string {
	const out: string[] = [];
	let text: string[] = [];
	let fence: { marker: string; lines: string[] } | null = null;

	const flushText = () => {
		if (text.length) out.push(...convertText(text.join("\n")));
		text = [];
	};

	// Code and math blocks are literal in Notion: pass them through untouched.
	for (const line of body.split("\n")) {
		if (fence) {
			fence.lines.push(line);
			if (closesFence(line, fence.marker)) {
				out.push(...fence.lines);
				fence = null;
			}
			continue;
		}
		const open = line.match(/^\s*(`{3,}|~{3,}|\$\$)/);
		if (open && !(open[1] === "$$" && /\$\$.*\$\$/.test(line))) {
			flushText();
			fence = { marker: open[1], lines: [line] };
			continue;
		}
		text.push(line);
	}
	flushText();
	if (fence) out.push(...fence.lines);

	return out.join("\n").trim();
}

function closesFence(line: string, marker: string): boolean {
	const trimmed = line.trim();
	if (marker === "$$") return trimmed.endsWith("$$");
	return trimmed.startsWith(marker) && trimmed.replace(new RegExp(`^\\${marker[0]}+`), "") === "";
}

/** Converts a run of non-code lines. Inline code spans are masked so they stay literal. */
function convertText(text: string): string[] {
	const spans: string[] = [];
	const masked = text
		.replace(/(`+)[^`\n]*?\1/g, (code) => `\u0000${spans.push(code) - 1}\u0000`)
		// %% comments %% and HTML comments are private to the vault and must never be published.
		.replace(/%%[\s\S]*?%%/g, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	const lines = groupQuotes(normalizeIndentation(masked.split("\n")));
	return lines.map((line) => line.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]));
}

/** Notion nests blocks with tabs. Space indentation is converted using the note's indent unit. */
function normalizeIndentation(lines: string[]): string[] {
	const spaceIndents = lines
		.map((line) => line.match(/^( +)\S/)?.[1].length ?? 0)
		.filter((n) => n > 0);
	const unit = spaceIndents.length ? Math.max(2, Math.min(4, ...spaceIndents)) : 4;

	return lines.map((line) => {
		const [, indent, rest] = line.match(/^([ \t]*)(.*)$/) as RegExpMatchArray;
		if (!indent || !rest) return rest;
		let depth = 0;
		let spaces = 0;
		for (const ch of indent) {
			if (ch === "\t") {
				depth += 1 + Math.floor(spaces / unit);
				spaces = 0;
			} else spaces++;
		}
		depth += Math.round(spaces / unit);
		return "\t".repeat(depth) + rest;
	});
}

/** Rewrites runs of `>` lines into Notion callouts or single multi-line quotes. */
function groupQuotes(lines: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length; ) {
		const quote = lines[i].match(/^(\t*)>/);
		if (!quote) {
			if (lines[i].trim()) out.push(convertLine(lines[i]));
			i++;
			continue;
		}

		const indent = quote[1];
		const group: string[] = [];
		while (i < lines.length && lines[i].startsWith(indent + ">")) {
			group.push(lines[i].slice(indent.length + 1).replace(/^ /, ""));
			i++;
		}

		const callout = group[0].match(/^\[!([\w-]+)\][+-]?\s*(.*)$/);
		if (callout) {
			const kind = callout[1].toLowerCase();
			const style = CALLOUT_STYLES[kind] ?? DEFAULT_CALLOUT;
			const title = callout[2].trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
			out.push(`${indent}<callout icon="${style.emoji}" color="${style.color}">`);
			out.push(`${indent}\t**${convertInline(title)}**`);
			// Callout bodies may hold any block, including nested quotes and callouts.
			for (const line of groupQuotes(normalizeIndentation(group.slice(1)))) out.push(`${indent}\t${line}`);
			out.push(`${indent}</callout>`);
		} else {
			const body = group.filter((line) => line.trim()).map(convertInline);
			if (body.length) out.push(`${indent}> ${body.join("<br>")}`);
		}
	}
	return out;
}

function convertLine(line: string): string {
	const [, indent, rest] = line.match(/^(\t*)(.*)$/) as RegExpMatchArray;
	const content = rest
		// Obsidian block IDs (`^abc123`) mean nothing in Notion.
		.replace(/\s+\^[\w-]+$/, "")
		// Task statuses: Notion only knows checked and unchecked, so `[/]`, `[-]` etc. stay open.
		.replace(/^([-*+]|\d+[.)]) \[([^\]])\]/, (_, bullet: string, mark: string) => `${bullet} [${/x/i.test(mark) ? "x" : " "}]`);
	return indent + convertInline(content);
}

function convertInline(text: string): string {
	// URLs are masked so that escaping below never alters them.
	const urls: string[] = [];
	const mask = (url: string) => `\u0001${urls.push(url) - 1}\u0001`;
	return (
		text
			// Embeds and local files cannot be uploaded yet; leave a visible marker instead.
			.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, (_, target: string) =>
				IMAGE_EXTENSIONS.test(target) ? `*\\[image: ${target}\\]*` : `*\\[embed: ${target}\\]*`,
			)
			.replace(/!\[([^\]]*)\]\((?!https?:)([^)]*)\)/g, (_, alt: string, src: string) => `*\\[image: ${alt || src}\\]*`)
			// [[target#heading|alias]] -> alias, [[target#heading]] -> target › heading
			.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) =>
				alias ?? target.replace(/#\^?/, " › ").trim(),
			)
			// Links to other notes or local files have no meaning in Notion; keep their text.
			// (Local images were already replaced above, so this cannot match an image.)
			.replace(/\[([^\]]*)\]\((?!https?:|mailto:)[^)]*\)/g, "$1")
			// Footnotes would otherwise be read as Notion citations (`[^URL]`).
			.replace(/\[\^([^\]]+)\]/g, "\\[^$1\\]")
			.replace(/==([^=\n]+)==/g, '<span color="yellow_bg">$1</span>')
			.replace(/<mark>(.*?)<\/mark>/gi, '<span color="yellow_bg">$1</span>')
			.replace(/<u>(.*?)<\/u>/gi, '<span underline="true">$1</span>')
			.replace(/\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/g, (_, url: string) => `](${mask(url)})`)
			.replace(/https?:\/\/[^\s<>()\u0001]+/g, mask)
			.replace(/</g, (lt, offset: number, all: string) => (ALLOWED_TAGS.test(all.slice(offset)) ? lt : "\\<"))
			// A lone `~` is literal in Obsidian but would start strikethrough in Notion. (No
			// lookbehind: it breaks on older mobile WebViews.)
			.replace(/\\~|~+/g, (match) => (match === "~" ? "\\~" : match))
			.replace(/\u0001(\d+)\u0001/g, (_, i) => urls[Number(i)])
	);
}
