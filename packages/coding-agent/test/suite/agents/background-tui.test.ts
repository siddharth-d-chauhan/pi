import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	getBackgroundProcessRegistry,
	resetForTests as resetRegistry,
} from "../../../src/core/background-process-registry.ts";
import { BackgroundLogPanel } from "../../../src/modes/interactive/components/background-log-panel.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

describe("background TUI surfaces", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		resetRegistry();
	});

	it("renders log-panel metrics and lets the selected process be killed", () => {
		const onKill = vi.fn();
		const registry = getBackgroundProcessRegistry();
		const id = registry.register({
			kind: "subagent",
			label: "reviewer",
			summary: "check implementation",
			agentType: "reviewer",
			onKill,
		});
		registry.appendLog(id, "found issue");
		registry.update(id, {
			metrics: { tokens: 1234, costUsd: 0.0123, requests: 2, contextPct: 42.5 },
			resultHandle: "agent://abc",
		});

		const panel = new BackgroundLogPanel({
			terminal: {} as Terminal,
			onDismiss: () => {},
		});

		const rendered = stripAnsi(panel.render(100).join("\n"));
		expect(rendered).toContain("reviewer");
		expect(rendered).toContain("check implementation");
		expect(rendered).toContain("1234 tok");
		expect(rendered).toContain("$0.0123");
		expect(rendered).toContain("2 req");
		expect(rendered).toContain("42.5% ctx");
		expect(rendered).toContain("agent://abc");
		expect(rendered).toContain("found issue");

		panel.handleInput("x");
		expect(onKill).toHaveBeenCalledTimes(1);
		panel.dispose();
	});
});
