import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentArtifact {
	id: string;
	path: string;
	bytes: number;
}

export interface AgentReturn {
	inline: string;
	handle?: string;
	artifact?: AgentArtifact;
}

export interface AgentHandleStoreOptions {
	artifactDir: string;
	inlineCapChars?: number;
}

const DEFAULT_INLINE_CAP_CHARS = 4_000;
const JSON_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

export class AgentHandleStore {
	#artifactDir: string;
	#inlineCapChars: number;

	constructor(options: AgentHandleStoreOptions) {
		this.#artifactDir = options.artifactDir;
		this.#inlineCapChars = options.inlineCapChars ?? DEFAULT_INLINE_CAP_CHARS;
	}

	capReturn(id: string, text: string, capChars = this.#inlineCapChars): AgentReturn {
		if (text.length <= capChars) {
			return { inline: text };
		}

		const artifactPath = this.#writeArtifact(id, text);
		const handle = `agent://${id}`;
		const head = text.slice(0, capChars);
		const omitted = text.length - head.length;
		return {
			inline: `${head}\n\n[agent output truncated: ${omitted} chars omitted. Full output: ${handle}]`,
			handle,
			artifact: {
				id,
				path: artifactPath,
				bytes: Buffer.byteLength(text, "utf-8"),
			},
		};
	}

	pull(ref: string): string {
		const parsed = parseAgentRef(ref);
		const artifactPath = this.#artifactPath(parsed.id);
		if (!existsSync(artifactPath)) {
			throw new Error(`No agent artifact found for ${parsed.id}`);
		}
		const text = readFileSync(artifactPath, "utf-8");

		if (parsed.query) {
			return pullRegexWindow(text, parsed.query);
		}

		if (parsed.path.length > 0) {
			return pullJsonPath(text, parsed.path);
		}

		return text;
	}

	#writeArtifact(id: string, text: string): string {
		validateArtifactId(id);
		mkdirSync(this.#artifactDir, { recursive: true });
		const artifactPath = this.#artifactPath(id);
		writeFileSync(artifactPath, text);
		return artifactPath;
	}

	#artifactPath(id: string): string {
		validateArtifactId(id);
		return join(this.#artifactDir, `${id}.md`);
	}
}

export function capReturn(id: string, text: string, options: AgentHandleStoreOptions): AgentReturn {
	return new AgentHandleStore(options).capReturn(id, text);
}

export function pullHandle(ref: string, options: AgentHandleStoreOptions): string {
	return new AgentHandleStore(options).pull(ref);
}

interface ParsedAgentRef {
	id: string;
	path: string[];
	query?: string;
}

function parseAgentRef(ref: string): ParsedAgentRef {
	let url: URL;
	try {
		url = new URL(ref);
	} catch {
		throw new Error(`Invalid agent ref: ${ref}`);
	}
	if (url.protocol !== "agent:" || !url.hostname) {
		throw new Error(`Invalid agent ref: ${ref}`);
	}
	const id = url.hostname;
	validateArtifactId(id);
	const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	const path = rawPath ? rawPath.split(".").filter((segment) => segment.length > 0) : [];
	for (const segment of path) {
		if (!JSON_PATH_SEGMENT.test(segment)) {
			throw new Error(`Invalid agent ref path segment: ${segment}`);
		}
	}
	const query = url.searchParams.get("q") ?? undefined;
	return { id, path, query };
}

function validateArtifactId(id: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
		throw new Error(`Invalid agent artifact id: ${id}`);
	}
}

function pullJsonPath(text: string, path: string[]): string {
	let current: unknown;
	try {
		current = JSON.parse(text);
	} catch {
		throw new Error("Agent artifact is not JSON");
	}

	for (const segment of path) {
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				throw new Error(`JSON path not found: ${path.join(".")}`);
			}
			current = current[index];
			continue;
		}
		if (typeof current === "object" && current !== null && segment in current) {
			current = (current as Record<string, unknown>)[segment];
			continue;
		}
		throw new Error(`JSON path not found: ${path.join(".")}`);
	}

	if (typeof current === "string") return current;
	return JSON.stringify(current, null, 2);
}

function pullRegexWindow(text: string, query: string): string {
	const regex = createQueryRegex(query);
	const match = regex.exec(text);
	if (!match || match.index === undefined) {
		throw new Error(`No match for query: ${query}`);
	}
	const start = Math.max(0, match.index - 500);
	const end = Math.min(text.length, match.index + match[0].length + 500);
	return text.slice(start, end);
}

function createQueryRegex(query: string): RegExp {
	if (query.startsWith("/") && query.lastIndexOf("/") > 0) {
		const lastSlash = query.lastIndexOf("/");
		const pattern = query.slice(1, lastSlash);
		const flags = query.slice(lastSlash + 1);
		return new RegExp(pattern, flags);
	}
	return new RegExp(escapeRegExp(query), "i");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
