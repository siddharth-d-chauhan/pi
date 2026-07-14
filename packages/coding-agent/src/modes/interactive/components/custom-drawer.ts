import type { Component, SizeValue, TUI } from "@earendil-works/pi-tui";
import { isFocusable } from "@earendil-works/pi-tui";

function resolveHeight(height: SizeValue, terminalRows: number): number {
	if (typeof height === "number") return Math.max(1, Math.floor(height));
	const match = /^(\d+(?:\.\d+)?)%$/.exec(height);
	if (!match) return 1;
	return Math.max(1, Math.floor((terminalRows * Number(match[1])) / 100));
}

/** Gives any extension custom component an inline, bottom-drawer footprint. */
export class CustomDrawerComponent implements Component {
	private readonly tui: TUI;
	private readonly child: Component & { dispose?(): void };
	private readonly height: SizeValue;

	constructor(tui: TUI, child: Component & { dispose?(): void }, height: SizeValue) {
		this.tui = tui;
		this.child = child;
		this.height = height;
	}

	get focused(): boolean {
		return isFocusable(this.child) ? this.child.focused : false;
	}

	set focused(focused: boolean) {
		if (isFocusable(this.child)) this.child.focused = focused;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.child.wantsKeyRelease;
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	render(width: number): string[] {
		const lines = this.child.render(width);
		const height = resolveHeight(this.height, this.tui.terminal.rows);
		while (lines.length < height) lines.push("");
		return lines;
	}

	invalidate(): void {
		this.child.invalidate();
	}

	dispose(): void {
		this.child.dispose?.();
	}
}
