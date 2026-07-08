/**
 * Agent Notify Extension — desktop + in-TUI notification when a subagent
 * finishes.
 *
 * Background agents complete between turns; if you've tabbed away, nothing
 * tells you. This extension watches the core BackgroundProcessRegistry and,
 * when a subagent flips to completed/failed/cancelled, fires:
 *   - an in-TUI notice (ctx.ui.notify), and
 *   - a desktop notification (OSC 99 / OSC 777 / notify-send, via pi-tui).
 *
 * Pure observation — no core changes, no tools registered.
 */

import { type ExtensionAPI, formatTaskAge, getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { type Component, notify as desktopNotify } from "@earendil-works/pi-tui";
import { cardLines } from "./lib/card.ts";

interface TaskNotificationDetails {
	registryId?: string;
	agent?: string;
	status?: string;
	handle?: string;
	usage?: { tokens?: number; costUsd?: number; durationMs?: number };
}

type ThemeLike = { fg(name: string, text: string): string; bold(text: string): string };

/** Extract the agent's result text from the model-facing XML wrapper. */
function extractInline(content: string): string {
	const match = content.match(/<task-notification[^>]*>\n?([\s\S]*?)\n?<\/task-notification>/);
	const body = (match ? match[1] : content)
		.replace(/\n*_agentId: [^\n]*_\s*$/, "")
		.replace(/\nhandle: agent:\/\/\S+\s*$/, "")
		.trim();
	return body;
}

class NotificationCard implements Component {
	private theme: ThemeLike;
	private title: string;
	private body: string[];
	private failed: boolean;

	constructor(theme: ThemeLike, details: TaskNotificationDetails, content: string) {
		this.theme = theme;
		this.failed = details.status === "failed";
		const glyph = this.failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const name = theme.fg("accent", theme.bold(details.agent ?? "agent"));
		const verb = details.status === "completed" ? "finished" : (details.status ?? "done");
		const metrics: string[] = [];
		const usage = details.usage;
		if (usage?.tokens)
			metrics.push(`${usage.tokens < 1000 ? usage.tokens : `${(usage.tokens / 1000).toFixed(1)}k`} tok`);
		if (usage?.costUsd) metrics.push(`$${usage.costUsd.toFixed(4)}`);
		if (usage?.durationMs) metrics.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
		const metricsText = metrics.length > 0 ? theme.fg("dim", ` · ${metrics.join(" · ")}`) : "";
		this.title = `${glyph} ${name} ${theme.fg("muted", verb)}${metricsText}`;
		this.body = extractInline(content)
			.split("\n")
			.slice(0, 12)
			.map((line) => theme.fg("toolOutput", line));
		if (details.handle) {
			this.body.push(theme.fg("dim", `⤷ ${details.handle} (agent_pull)`));
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		return cardLines({
			width,
			title: this.title,
			body: this.body,
			edge: (text) => this.theme.fg(this.failed ? "error" : "success", text),
		});
	}
}

export default function (pi: ExtensionAPI) {
	let unsubscribe: (() => void) | undefined;

	// Render background-completion notifications as a compact card instead
	// of the raw <task-notification> XML the model sees.
	pi.registerMessageRenderer<TaskNotificationDetails>("task-notification", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new NotificationCard(theme, message.details ?? {}, content);
	});

	// Child → parent A2A messages render as an accent card.
	pi.registerMessageRenderer<{ from?: string }>("agent-message", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const body = (content.match(/<agent-message[^>]*>\n?([\s\S]*?)\n?<\/agent-message>/)?.[1] ?? content).trim();
		const from = message.details?.from ?? "agent";
		const title = `${theme.fg("accent", "✉")} ${theme.fg("accent", theme.bold(from))} ${theme.fg("muted", "says")}`;
		const lines = body
			.split("\n")
			.slice(0, 12)
			.map((line) => theme.fg("toolOutput", line));
		return {
			render: (width: number) => cardLines({ width, title, body: lines, edge: (t) => theme.fg("accent", t) }),
			invalidate() {},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		unsubscribe?.();
		const registry = getBackgroundProcessRegistry();
		unsubscribe = registry.subscribe((event) => {
			if (event.type !== "statusChange") return;
			if (event.status !== "completed" && event.status !== "failed" && event.status !== "cancelled") return;
			const entry = registry.get(event.id);
			if (!entry || entry.kind !== "subagent") return;

			const name = entry.agentType ?? "agent";
			const verb = event.status === "completed" ? "finished" : event.status;
			// The label already leads with the agent type — don't repeat it.
			const gist = entry.label.startsWith(`${name} · `) ? entry.label.slice(name.length + 3) : entry.label;
			ctx.ui.notify(
				`${name} ${verb} after ${formatTaskAge(entry)} — ${gist}`,
				event.status === "failed" ? "error" : "info",
			);
			desktopNotify(`pi · ${name} ${verb}`, gist);
		});
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
}
