import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { bundledAgentSources } from "./bundled.ts";

export type AgentDefinitionSource = "bundled" | "user" | "project" | "package";
export type AgentToolList = string[] | "*";
export type AgentSpawnPolicy = string[] | "*" | "none";
export type AgentPermissionMode = "inherit" | "bubble" | "auto" | "read-only";
export type AgentIsolationMode = "none" | "worktree";

export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: AgentToolList;
	disallowedTools?: string[];
	permissionMode?: AgentPermissionMode;
	spawns?: AgentSpawnPolicy;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxTurns?: number;
	background?: boolean;
	isolation?: AgentIsolationMode;
	omitProjectContext?: boolean;
	output?: TSchema;
	color?: string;
	source: AgentDefinitionSource;
	filePath?: string;
}

export interface AgentDefinitionFrontmatter {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	disallowedTools?: unknown;
	disallowed_tools?: unknown;
	permissionMode?: unknown;
	permission_mode?: unknown;
	spawns?: unknown;
	model?: unknown;
	thinkingLevel?: unknown;
	thinking_level?: unknown;
	maxTurns?: unknown;
	max_turns?: unknown;
	background?: unknown;
	isolation?: unknown;
	omitProjectContext?: unknown;
	omit_project_context?: unknown;
	output?: unknown;
	color?: unknown;
	[key: string]: unknown;
}

export interface AgentDefinitionRegistry {
	get(name: string): AgentDefinition | undefined;
	list(): AgentDefinition[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadAgentDefinitionsOptions {
	cwd: string;
	agentDir: string;
	packageAgentDirs?: string[];
}

const KNOWN_FRONTMATTER_KEYS = new Set([
	"name",
	"description",
	"tools",
	"disallowedTools",
	"disallowed_tools",
	"permissionMode",
	"permission_mode",
	"spawns",
	"model",
	"thinkingLevel",
	"thinking_level",
	"maxTurns",
	"max_turns",
	"background",
	"isolation",
	"omitProjectContext",
	"omit_project_context",
	"output",
	"color",
]);

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high"]);
const VALID_PERMISSION_MODES = new Set(["inherit", "bubble", "auto", "read-only"]);
const VALID_ISOLATION_MODES = new Set(["none", "worktree"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "agent_pull", "agent_list"]);

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function listMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];

	function visit(currentDir: string): void {
		let entries: Array<Dirent<string>>;
		try {
			entries = readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(currentDir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}
			if (isDirectory) {
				visit(fullPath);
				continue;
			}
			if (isFile && entry.name.endsWith(".md")) {
				files.push(fullPath);
			}
		}
	}

	visit(dir);
	return files;
}

function normalizeAgentName(name: string): string {
	return name.trim().toLowerCase();
}

function validateAgentName(name: string): string[] {
	const errors: string[] = [];
	if (name.trim() === "") {
		errors.push("name is required");
		return errors;
	}
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) {
		errors.push("name contains invalid characters");
	}
	return errors;
}

function parseStringList(
	value: unknown,
	field: string,
	diagnostics: ResourceDiagnostic[],
	path?: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value.map((item) => item.trim()).filter((item) => item.length > 0);
	}
	diagnostics.push({ type: "warning", message: `${field} must be a string or string array`, path });
	return undefined;
}

function parseToolList(value: unknown, diagnostics: ResourceDiagnostic[], path?: string): AgentToolList | undefined {
	if (value === "*") return "*";
	return parseStringList(value, "tools", diagnostics, path);
}

function parseSpawnPolicy(
	value: unknown,
	diagnostics: ResourceDiagnostic[],
	path?: string,
): AgentSpawnPolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "*" || value === "none") return value;
	return parseStringList(value, "spawns", diagnostics, path);
}

function parseBoolean(
	value: unknown,
	field: string,
	diagnostics: ResourceDiagnostic[],
	path?: string,
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	diagnostics.push({ type: "warning", message: `${field} must be a boolean`, path });
	return undefined;
}

function parsePositiveInteger(
	value: unknown,
	field: string,
	diagnostics: ResourceDiagnostic[],
	path?: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	diagnostics.push({ type: "warning", message: `${field} must be a positive integer`, path });
	return undefined;
}

function parseThinkingLevel(
	value: unknown,
	diagnostics: ResourceDiagnostic[],
	path?: string,
): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && VALID_THINKING_LEVELS.has(value)) {
		return value as ThinkingLevel;
	}
	diagnostics.push({ type: "warning", message: "thinkingLevel must be off, minimal, low, medium, or high", path });
	return undefined;
}

function parsePermissionMode(
	value: unknown,
	diagnostics: ResourceDiagnostic[],
	path?: string,
): AgentPermissionMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && VALID_PERMISSION_MODES.has(value)) {
		return value as AgentPermissionMode;
	}
	diagnostics.push({ type: "warning", message: "permissionMode must be inherit, bubble, auto, or read-only", path });
	return undefined;
}

function parseIsolation(
	value: unknown,
	diagnostics: ResourceDiagnostic[],
	path?: string,
): AgentIsolationMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && VALID_ISOLATION_MODES.has(value)) {
		return value as AgentIsolationMode;
	}
	diagnostics.push({ type: "warning", message: "isolation must be none or worktree", path });
	return undefined;
}

function parseOutput(value: unknown): TSchema | undefined {
	if (value !== undefined && typeof value === "object" && value !== null) {
		return value as TSchema;
	}
	return undefined;
}

function getUnknownKeys(frontmatter: AgentDefinitionFrontmatter): string[] {
	return Object.keys(frontmatter).filter((key) => !KNOWN_FRONTMATTER_KEYS.has(key));
}

function createDefinition(
	rawContent: string,
	source: AgentDefinitionSource,
	filePath: string | undefined,
): { definition?: AgentDefinition; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	let frontmatter: AgentDefinitionFrontmatter;
	let body: string;
	try {
		const parsed = parseFrontmatter<AgentDefinitionFrontmatter>(rawContent);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse agent frontmatter";
		if (source === "bundled") throw new Error(`Invalid bundled agent ${filePath ?? "(inline)"}: ${message}`);
		return { diagnostics: [{ type: "warning", message, path: filePath }] };
	}

	for (const key of getUnknownKeys(frontmatter)) {
		diagnostics.push({ type: "warning", message: `unknown frontmatter field "${key}"`, path: filePath });
	}

	const rawName = typeof frontmatter.name === "string" ? frontmatter.name : "";
	for (const error of validateAgentName(rawName)) {
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
		diagnostics.push({ type: "warning", message: "description is required", path: filePath });
	}
	if (body.trim() === "") {
		diagnostics.push({ type: "warning", message: "system prompt body is required", path: filePath });
	}

	if (
		rawName.trim() === "" ||
		typeof frontmatter.description !== "string" ||
		frontmatter.description.trim() === "" ||
		body.trim() === "" ||
		validateAgentName(rawName).length > 0
	) {
		return { diagnostics };
	}

	const definition: AgentDefinition = {
		name: normalizeAgentName(rawName),
		description: frontmatter.description.trim(),
		systemPrompt: body,
		tools: parseToolList(frontmatter.tools, diagnostics, filePath),
		disallowedTools: parseStringList(
			frontmatter.disallowedTools ?? frontmatter.disallowed_tools,
			"disallowedTools",
			diagnostics,
			filePath,
		),
		permissionMode: parsePermissionMode(
			frontmatter.permissionMode ?? frontmatter.permission_mode,
			diagnostics,
			filePath,
		),
		spawns: parseSpawnPolicy(frontmatter.spawns, diagnostics, filePath),
		model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
		thinkingLevel: parseThinkingLevel(frontmatter.thinkingLevel ?? frontmatter.thinking_level, diagnostics, filePath),
		maxTurns: parsePositiveInteger(frontmatter.maxTurns ?? frontmatter.max_turns, "maxTurns", diagnostics, filePath),
		background: parseBoolean(frontmatter.background, "background", diagnostics, filePath),
		isolation: parseIsolation(frontmatter.isolation, diagnostics, filePath),
		omitProjectContext: parseBoolean(
			frontmatter.omitProjectContext ?? frontmatter.omit_project_context,
			"omitProjectContext",
			diagnostics,
			filePath,
		),
		output: parseOutput(frontmatter.output),
		color: typeof frontmatter.color === "string" && frontmatter.color.trim() ? frontmatter.color.trim() : undefined,
		source,
		filePath,
	};

	return { definition, diagnostics };
}

function addDefinition(
	byName: Map<string, AgentDefinition>,
	diagnostics: ResourceDiagnostic[],
	definition: AgentDefinition,
): void {
	const existing = byName.get(definition.name);
	if (existing) {
		diagnostics.push({
			type: "warning",
			message: `agent "${definition.name}" ignored because it is already defined by ${existing.filePath ?? existing.source}`,
			path: definition.filePath,
		});
		return;
	}
	byName.set(definition.name, definition);
}

function loadFromFile(
	filePath: string,
	source: AgentDefinitionSource,
): { definition?: AgentDefinition; diagnostics: ResourceDiagnostic[] } {
	try {
		const content = readFileSync(filePath, "utf-8");
		return createDefinition(content, source, filePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read agent definition";
		return { diagnostics: [{ type: "warning", message, path: filePath }] };
	}
}

export function loadAgentDefinitions(options: LoadAgentDefinitionsOptions): AgentDefinitionRegistry {
	const cwd = resolvePath(options.cwd);
	const agentDir = resolvePath(options.agentDir);
	const byName = new Map<string, AgentDefinition>();
	const diagnostics: ResourceDiagnostic[] = [];
	const packageAgentDirs = options.packageAgentDirs ?? [];
	const sources: Array<{ source: AgentDefinitionSource; dir: string }> = [
		{ source: "project", dir: join(cwd, CONFIG_DIR_NAME, "agents") },
		{ source: "user", dir: join(agentDir, "agents") },
		...packageAgentDirs.map((dir) => ({ source: "package" as const, dir: resolvePath(dir) })),
	];

	for (const { source, dir } of sources) {
		for (const filePath of listMarkdownFiles(dir)) {
			const result = loadFromFile(filePath, source);
			diagnostics.push(...result.diagnostics);
			if (result.definition) addDefinition(byName, diagnostics, result.definition);
		}
	}

	for (const bundled of bundledAgentSources) {
		const result = createDefinition(bundled.content, "bundled", `bundled:${bundled.name}`);
		diagnostics.push(...result.diagnostics);
		if (result.definition) addDefinition(byName, diagnostics, result.definition);
	}

	return {
		diagnostics,
		get(name: string) {
			return byName.get(normalizeAgentName(name));
		},
		list() {
			return Array.from(byName.values()).sort((a, b) => {
				const sourceOrder = sourceRank(a.source) - sourceRank(b.source);
				return sourceOrder !== 0 ? sourceOrder : a.name.localeCompare(b.name);
			});
		},
	};
}

function sourceRank(source: AgentDefinitionSource): number {
	switch (source) {
		case "project":
			return 0;
		case "user":
			return 1;
		case "package":
			return 2;
		case "bundled":
			return 3;
	}
}

export function formatAgentDefinitionsForPrompt(definitions: AgentDefinition[], limit = 12): string {
	const visible = definitions.slice(0, Math.max(0, limit));
	if (definitions.length === 0) return "";
	const lines = ["Available subagents:"];
	for (const definition of visible) {
		const sourceSuffix = definition.source === "bundled" ? "" : ` (${definition.source})`;
		lines.push(`- ${definition.name}${sourceSuffix}: ${definition.description}`);
	}
	if (definitions.length > visible.length) {
		lines.push(`- ${definitions.length - visible.length} more available via agent_list`);
	}
	return lines.join("\n");
}

export function canOmitProjectContext(
	definition: AgentDefinition,
	options: { allowUserProject?: boolean } = {},
): boolean {
	if (!definition.omitProjectContext) return false;
	if (definition.source !== "bundled") return options.allowUserProject === true;
	return isReadOnlyToolSet(definition.tools, definition.disallowedTools);
}

export function isReadOnlyToolSet(tools: AgentToolList | undefined, disallowedTools: string[] | undefined): boolean {
	if (tools === undefined || tools === "*") return false;
	const allowed = new Set(tools.map((tool) => tool.toLowerCase()));
	for (const disallowedTool of disallowedTools ?? []) {
		allowed.delete(disallowedTool.toLowerCase());
	}
	return Array.from(allowed).every((tool) => READ_ONLY_TOOLS.has(tool));
}

export function createAgentDefinitionDisplayPath(definition: AgentDefinition, cwd: string): string {
	if (!definition.filePath) return definition.source;
	if (definition.filePath.startsWith("bundled:")) return definition.filePath;
	const relativePath = relative(cwd, definition.filePath);
	if (!relativePath.startsWith("..")) return toPosixPath(relativePath);
	return toPosixPath(definition.filePath);
}

export function inferAgentNameFromFile(filePath: string): string {
	return basename(filePath, ".md");
}
