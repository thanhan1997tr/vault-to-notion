import { App, FuzzySuggestModal, Modal, Setting, TFolder } from "obsidian";

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private readonly onChoose: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a folder to publish to Notion");
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
	}

	getItemText(folder: TFolder): string {
		return folder.isRoot() ? "/ (entire vault)" : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

/** Resolves to true when the user confirms, false when they cancel or close the dialog. */
export function confirm(app: App, title: string, message: string, cta: string): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const modal = new Modal(app);
		modal.titleEl.setText(title);
		modal.contentEl.createEl("p", { text: message });
		new Setting(modal.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
			.addButton((button) =>
				button
					.setButtonText(cta)
					.setCta()
					.onClick(() => {
						confirmed = true;
						modal.close();
					}),
			);
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}
