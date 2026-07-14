import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;
	/**
	 * Handler invoked when the user presses Down arrow with an empty prompt.
	 * Used by the owner to open contextual background activity without
	 * changing Down-arrow behavior while the user is editing text.
	 */
	public onDownArrowOnEmpty?: () => boolean;
	/**
	 * Handler invoked when the user presses Down arrow while the cursor is
	 * already on the LAST line of the editor (and the buffer is
	 * non-empty). Lets the owner scroll the chat scrollback DOWN by one
	 * line, the way Claude Code does — the cursor stays put in the editor
	 * while the visible scrollback moves. Returns true to consume.
	 */
	public onDownArrowOnLastLine?: () => boolean;
	/**
	 * Symmetric handler for Up arrow on the FIRST line of a non-empty
	 * editor: scroll the chat scrollback UP by one line.
	 */
	public onUpArrowOnFirstLine?: () => boolean;
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}
		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Down on an empty prompt may open contextual background activity.
		if (
			!this.isShowingAutocomplete() &&
			this.getText().length === 0 &&
			this.keybindings.matches(data, "tui.editor.cursorDown") &&
			this.onDownArrowOnEmpty?.() === true
		) {
			return;
		}

		// Down on the LAST line / Up on the FIRST line of a non-empty editor
		// scrolls the chat scrollback by one line (Claude Code's behavior).
		// We match via the keybinding name so the same keychord the editor
		// uses for cursor movement triggers the scroll hook.
		if (
			!this.isShowingAutocomplete() &&
			this.getText().length > 0 &&
			this.keybindings.matches(data, "tui.editor.cursorDown")
		) {
			if (this.getCursorLine() >= this.getLineCount() - 1 && this.onDownArrowOnLastLine?.() === true) {
				return;
			}
		}
		if (
			!this.isShowingAutocomplete() &&
			this.getText().length > 0 &&
			this.keybindings.matches(data, "tui.editor.cursorUp")
		) {
			if (this.getCursorLine() <= 0 && this.onUpArrowOnFirstLine?.() === true) {
				return;
			}
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
