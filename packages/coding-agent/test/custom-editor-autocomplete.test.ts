import { type AutocompleteProvider, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("CustomEditor autocomplete navigation", () => {
	beforeAll(() => initTheme("dark"));

	test("keeps prompt-boundary scroll hooks out of autocomplete navigation", async () => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TUI(new VirtualTerminal()), getEditorTheme(), keybindings);
		const provider: AutocompleteProvider = {
			getSuggestions: async () => ({
				items: [
					{ value: "/settings", label: "settings" },
					{ value: "/model", label: "model" },
				],
				prefix: "/",
			}),
			applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
				lines: lines.map((line, index) => (index === cursorLine ? item.value : line)),
				cursorLine,
				cursorCol: item.value.length,
			}),
		};
		editor.setAutocompleteProvider(provider);

		let scrollHookCalls = 0;
		editor.onDownArrowOnLastLine = () => {
			scrollHookCalls++;
			return true;
		};

		editor.handleInput("/");
		await Promise.resolve();
		await Promise.resolve();
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b[B");
		expect(scrollHookCalls).toBe(0);

		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("\r");
		expect(submitted).toBe("/model");
	});

	test("offers empty-prompt Down to the contextual activity handler", () => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TUI(new VirtualTerminal()), getEditorTheme(), keybindings);
		let calls = 0;
		editor.onDownArrowOnEmpty = () => {
			calls++;
			return true;
		};

		editor.handleInput("\x1b[B");

		expect(calls).toBe(1);
		expect(editor.getText()).toBe("");
	});

	test("does not offer non-empty prompts to the activity handler", () => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TUI(new VirtualTerminal()), getEditorTheme(), keybindings);
		let calls = 0;
		editor.onDownArrowOnEmpty = () => {
			calls++;
			return true;
		};
		editor.setText("draft");

		editor.handleInput("\x1b[B");

		expect(calls).toBe(0);
		expect(editor.getText()).toBe("draft");
	});
});
