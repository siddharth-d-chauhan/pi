/**
 * Plain-text tool-call summaries for non-TUI consumers such as ACP clients,
 * background-process logs, exports, and diagnostics.
 *
 * Keep this renderer theme-free and bounded. Large mutation payloads and
 * credential-like fields are deliberately omitted from the generic fallback.
 */

const SECRET_KEY = /(api[-_]?key|authorization|cookie|credential|password|secret|token)/i;
const LARGE_VALUE_KEY = /^(content|newText|oldText|patch|source|text)$/i;

function recordOf(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function textOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compact(value: string): string {
	return value
		.replace(/[\x00-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function bounded(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function shortenPath(value: string, cwd: string): string {
	const path = compact(value || ".");
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
	if (cwd && path === cwd) return ".";
	return path;
}

function taskSummary(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const tasks = value.map(recordOf);
	if (tasks.length === 1) {
		const task = tasks[0];
		const agent = textOf(task.agent) ?? "agent";
		const background = task.background === true ? " (background)" : "";
		const prompt = compact(textOf(task.prompt) ?? "");
		return `${agent}${background}${prompt ? ` ${prompt}` : ""}`;
	}
	const agents = tasks.map((task) => {
		const agent = textOf(task.agent) ?? "agent";
		return task.background === true ? `${agent} (background)` : agent;
	});
	return `${tasks.length} tasks: ${agents.join(", ")}`;
}

function genericSummary(name: string, args: Record<string, unknown>, cwd: string): string {
	const command = textOf(args.command) ?? textOf(args.cmd);
	if (command !== undefined) return `$ ${compact(command)}`;

	const path = textOf(args.path) ?? textOf(args.file_path);
	if (path !== undefined) return `${name} ${shortenPath(path, cwd)}`;

	const query = textOf(args.query) ?? textOf(args.q) ?? textOf(args.pattern);
	if (query !== undefined) return `${name} ${compact(query)}`;

	const url = textOf(args.url);
	if (url !== undefined) return `${name} ${compact(url)}`;

	const fields: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (fields.length >= 3 || LARGE_VALUE_KEY.test(key)) continue;
		if (SECRET_KEY.test(key)) {
			fields.push(`${key}=<redacted>`);
			continue;
		}
		if (typeof value === "string") fields.push(`${key}=${compact(value)}`);
		else if (typeof value === "number" || typeof value === "boolean") fields.push(`${key}=${String(value)}`);
	}
	return fields.length > 0 ? `${name} ${fields.join(" ")}` : name;
}

/** Render the same useful call identity the interactive tools show, without ANSI styling. */
export function formatToolCallSummary(name: string, value: unknown, cwd: string, max = 360): string {
	const args = recordOf(value);
	let summary: string;
	switch (name) {
		case "find": {
			const pattern = compact(textOf(args.pattern) ?? "");
			const path = shortenPath(textOf(args.path) ?? ".", cwd);
			const limit = numberOf(args.limit);
			summary = `find ${pattern} in ${path}${limit === undefined ? "" : ` (limit ${limit})`}`;
			break;
		}
		case "grep": {
			const pattern = compact(textOf(args.pattern) ?? "");
			const path = shortenPath(textOf(args.path) ?? ".", cwd);
			const glob = compact(textOf(args.glob) ?? "");
			const limit = numberOf(args.limit);
			summary = `grep /${pattern}/ in ${path}${glob ? ` (${glob})` : ""}${limit === undefined ? "" : ` (limit ${limit})`}`;
			break;
		}
		case "read": {
			const path = shortenPath(textOf(args.file_path) ?? textOf(args.path) ?? "", cwd);
			const offset = numberOf(args.offset);
			const limit = numberOf(args.limit);
			let range = "";
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit === undefined ? "" : start + limit - 1;
				range = `:${start}${end === "" ? "" : `-${end}`}`;
			}
			summary = `read ${path}${range}`;
			break;
		}
		case "ls": {
			const path = shortenPath(textOf(args.path) ?? ".", cwd);
			const limit = numberOf(args.limit);
			summary = `ls ${path}${limit === undefined ? "" : ` (limit ${limit})`}`;
			break;
		}
		case "write":
		case "edit":
		case "compact_patch": {
			const path = shortenPath(textOf(args.file_path) ?? textOf(args.path) ?? "", cwd);
			summary = `${name} ${path}`;
			break;
		}
		case "bash":
		case "exec":
		case "exec_command": {
			const command = compact(textOf(args.command) ?? textOf(args.cmd) ?? "");
			const timeout = numberOf(args.timeout);
			summary = `$ ${command}${timeout === undefined ? "" : ` (timeout ${timeout}s)`}`;
			break;
		}
		case "agent":
			summary = `agent ${taskSummary(args.tasks) ?? ""}`.trim();
			break;
		case "agent_message": {
			const target = compact(textOf(args.to) ?? "agent");
			const message = compact(textOf(args.message) ?? "");
			summary = `message -> ${target}${message ? ` ${message}` : ""}`;
			break;
		}
		case "agent_pull":
			summary = `agent_pull ${compact(textOf(args.ref) ?? "")}`.trim();
			break;
		case "update_plan": {
			const tasks = Array.isArray(args.tasks) ? args.tasks.map(recordOf) : [];
			const active = tasks.find((task) => task.status === "in_progress");
			const subject = active ? compact(textOf(active.subject) ?? "") : "";
			summary = `plan ${tasks.length} tasks${subject ? `; in progress: ${subject}` : ""}`;
			break;
		}
		default:
			summary = genericSummary(name, args, cwd);
	}
	return bounded(summary, Math.max(24, max));
}

/** Flatten a provider-supplied reasoning summary for activity logs. */
export function formatThinkingSummary(value: string, max = 600): string {
	return bounded(compact(value), Math.max(24, max));
}
