/**
 * ToolInspectComponent — show one tool's metadata, parameter schema, and
 * prompt guidelines. Renders as a focusable container; Esc closes.
 *
 * Schema rendering: TypeBox schemas are JSON Schema objects, so we walk
 * the schema's `properties` and `required` arrays and produce a
 * human-readable summary: "param: type — description". Recurses one level
 * into object types to surface nested fields.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolInfo } from "../../../core/extensions/types.ts";
import { getCategoryLabel, getToolCategory } from "../../../core/tool-categories.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface ToolInspectOptions {
	tool: ToolInfo;
	enabled: boolean;
	onClose: () => void;
}

interface JsonSchemaProperty {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	items?: JsonSchemaProperty;
	anyOf?: JsonSchemaProperty[];
	oneOf?: JsonSchemaProperty[];
}

function schemaToString(schema: JsonSchemaProperty | undefined): string {
	if (!schema) return "any";
	if (schema.enum) return `enum(${schema.enum.map((v) => JSON.stringify(v)).join(" | ")})`;
	if (schema.anyOf) return schema.anyOf.map((s) => schemaToString(s)).join(" | ");
	if (schema.oneOf) return schema.oneOf.map((s) => schemaToString(s)).join(" | ");
	if (schema.type === "array") return `${schemaToString(schema.items)}[]`;
	if (schema.type === "object" || schema.properties) return "object";
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	return schema.type ?? "any";
}

function renderParams(tool: ToolInfo, width: number): string[] {
	const params = tool.parameters as
		| { properties?: Record<string, JsonSchemaProperty>; required?: string[] }
		| undefined;
	if (!params?.properties) {
		return [theme.fg("muted", "(no parameters)")];
	}
	const required = new Set(params.required ?? []);
	const lines: string[] = [];
	const indent = "  ";
	for (const [name, prop] of Object.entries(params.properties)) {
		const isReq = required.has(name);
		const label = theme.bold(theme.fg("text", name));
		const typeStr = theme.fg("muted", `: ${schemaToString(prop)}`);
		const reqMark = isReq ? theme.fg("error", " (required)") : theme.fg("dim", " (optional)");
		lines.push(indent + label + typeStr + reqMark);
		if (prop.description) {
			// Word-wrap at width - 4.
			const wrapAt = Math.max(40, width - 4);
			const desc = prop.description;
			let i = 0;
			while (i < desc.length) {
				const slice = desc.slice(i, i + wrapAt);
				lines.push(theme.fg("dim", `    ${slice}`));
				i += wrapAt;
			}
		}
	}
	return lines;
}

function renderGuidelines(tool: ToolInfo): string[] {
	if (!tool.promptGuidelines || tool.promptGuidelines.length === 0) return [];
	const lines: string[] = [theme.fg("accent", "Prompt guidelines:"), ""];
	for (const raw of tool.promptGuidelines) {
		lines.push(theme.fg("dim", `  ${raw}`));
	}
	return lines;
}

export class ToolInspectComponent extends Container {
	private readonly onClose: () => void;

	constructor(opts: ToolInspectOptions) {
		super();
		this.onClose = opts.onClose;

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", opts.tool.name)), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Category: ${getCategoryLabel(getToolCategory(opts.tool.name))} · ${opts.enabled ? "enabled" : "disabled"}`,
				),
				1,
				0,
			),
		);
		this.addChild(new Text(theme.fg("muted", `Source: ${opts.tool.sourceInfo?.path ?? "unknown"}`), 1, 0));

		if (opts.tool.description) {
			this.addChild(new Text(theme.fg("text", opts.tool.description), 1, 0));
			this.addChild(new Text("", 1, 0));
		}

		this.addChild(new Text(theme.fg("accent", "Parameters:"), 1, 0));
		this.addChild(new Text(renderParams(opts.tool, 100).join("\n"), 1, 0));
		this.addChild(new Text("", 1, 0));

		const guidelines = renderGuidelines(opts.tool);
		if (guidelines.length > 0) {
			for (const line of guidelines) {
				this.addChild(new Text(line, 1, 0));
			}
		}

		this.addChild(new Text("", 1, 0));
		this.addChild(new Text(theme.fg("dim", "Press Esc/q to close"), 1, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): boolean {
		if (data === "\x1b" || data === "q" || data === "Q") {
			this.onClose();
			return true;
		}
		return false;
	}
}
