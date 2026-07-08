/**
 * ToolSelectorComponent — pick which tools are active, grouped by category.
 *
 * Built on `SettingsList` so it gets search/filter for free. Each row is a
 * tool; the value column shows "on" / "off". Enter cycles the value. The
 * caller supplies the current selection and a callback to apply changes.
 *
 * Categories: derived from `getToolCategory(name)`. The list is sorted by
 * category (categories in declaration order), then by tool name within a
 * category.
 */

import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { ToolInfo } from "../../../core/extensions/types.ts";
import {
	getCategoryLabel,
	getToolCategory,
	TOOL_CATEGORIES,
	type ToolCategory,
} from "../../../core/tool-categories.ts";
import { getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface ToolSelectorOptions {
	tools: ToolInfo[];
	enabled: Set<string>;
	/** Called when the user changes which tools are active. */
	onChange: (enabled: Set<string>) => void;
	onClose: () => void;
}

function groupByCategory(tools: ToolInfo[]): Array<{ category: ToolCategory; tools: ToolInfo[] }> {
	const map = new Map<ToolCategory, ToolInfo[]>();
	for (const t of tools) {
		const cat = getToolCategory(t.name);
		const list = map.get(cat) ?? [];
		list.push(t);
		map.set(cat, list);
	}
	const out: Array<{ category: ToolCategory; tools: ToolInfo[] }> = [];
	for (const cat of TOOL_CATEGORIES) {
		const list = map.get(cat);
		if (list && list.length > 0) out.push({ category: cat, tools: list });
	}
	return out;
}

export class ToolSelectorComponent extends Container {
	private readonly enabled: Set<string>;
	private readonly onChange: (enabled: Set<string>) => void;

	constructor(opts: ToolSelectorOptions) {
		super();
		this.enabled = new Set(opts.enabled);
		this.onChange = opts.onChange;

		const items: SettingItem[] = [];
		const groups = groupByCategory(opts.tools);
		for (const group of groups) {
			// Non-interactive header row per category (values: [] means no cycle).
			items.push({
				id: `__header:${group.category}`,
				label: getCategoryLabel(group.category),
				currentValue: `${group.tools.length}`,
			});
			for (const tool of group.tools) {
				items.push({
					id: tool.name,
					label: tool.name,
					currentValue: this.enabled.has(tool.name) ? "on" : "off",
					values: ["on", "off"],
					description: tool.description ?? "",
				});
			}
		}

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Tools (Enter to toggle)")), 1, 0));
		this.addChild(new Spacer(1));

		const list = new SettingsList(
			items,
			16,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id.startsWith("__header:")) return;
				if (newValue === "on") this.enabled.add(id);
				else this.enabled.delete(id);
				this.onChange(new Set(this.enabled));
			},
			() => opts.onClose(),
			{ enableSearch: true },
		);
		this.addChild(list);
		this.addChild(new DynamicBorder());
	}
}
