import { addIcon } from "obsidian";

export const ICON_ID = "vault-to-notion-publish";

// A page with a folded corner and an upward arrow, drawn on Obsidian's 100×100 icon grid.
const PUBLISH_ICON = `
<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
	<path d="M60 8H26a6 6 0 0 0-6 6v72a6 6 0 0 0 6 6h48a6 6 0 0 0 6-6V28z"/>
	<path d="M60 8v20h20"/>
	<path d="M50 78V46"/>
	<path d="M36 60l14-14 14 14"/>
</g>`;

export function registerIcons(): void {
	addIcon(ICON_ID, PUBLISH_ICON);
}
