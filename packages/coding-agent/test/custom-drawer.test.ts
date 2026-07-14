import type { Component } from "@earendil-works/pi-tui";
import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CustomDrawerComponent } from "../src/modes/interactive/components/custom-drawer.ts";

describe("CustomDrawerComponent", () => {
	it("pads an arbitrary custom component to a percentage of terminal height", () => {
		const child: Component & { focused: boolean } = {
			focused: false,
			render: () => ["activity"],
			invalidate: () => {},
		};
		const drawer = new CustomDrawerComponent(new TUI(new VirtualTerminal(100, 30)), child, "40%");

		const lines = drawer.render(100);

		expect(lines).toHaveLength(12);
		expect(lines[0]).toBe("activity");
	});

	it("forwards focus, input, invalidation, and disposal to the custom component", () => {
		const events: string[] = [];
		const child: Component & { focused: boolean; dispose(): void } = {
			focused: false,
			render: () => ["activity"],
			handleInput: (data) => events.push(data),
			invalidate: () => events.push("invalidate"),
			dispose: () => events.push("dispose"),
		};
		const drawer = new CustomDrawerComponent(new TUI(new VirtualTerminal()), child, 8);

		drawer.focused = true;
		drawer.handleInput("down");
		drawer.invalidate();
		drawer.dispose();

		expect(child.focused).toBe(true);
		expect(events).toEqual(["down", "invalidate", "dispose"]);
	});
});
