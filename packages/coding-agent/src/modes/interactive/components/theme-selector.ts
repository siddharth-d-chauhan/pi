/**
 * ThemeSelectorComponent — pick a theme with live preview.
 *
 * On every selection change we call `onPreview(themeName)` so the
 * InteractiveThemeController can apply the new theme immediately; Enter
 * commits the change and Esc cancels (rolling back to the original theme).
 *
 * Each entry's description is a short, theme-rendered preview line so the
 * user can see at a glance what the theme looks like. Entries are grouped
 * by light/dark via `isLightTheme(name)`; groups are kept inline (no
 * collapsible sections) so the picker stays scannable.
 *
 * Backward compat: this component's public API is unchanged
 * (constructor signature, onSelect / onCancel / onPreview callbacks).
 */

import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { getAvailableThemes, getSelectListTheme, isLightTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const THEME_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 14,
	maxPrimaryColumnWidth: 28,
};

/** A short sample line used as the per-theme description in the selector. */
function buildPreviewLine(themeName: string): string {
	const t = theme;
	const safeName = (s: string) => s.padEnd(10).slice(0, 10);
	// Render a compact line that exercises the main palette tokens:
	//   model name in accent · success / error / warning indicators ·
	//   muted dim text · a code-span style bit.
	const swatch = `${t.fg("success", "✓ ok")} ${t.fg("error", "✗ no")} ${t.fg("warning", "! warn")}`;
	return [t.fg("accent", safeName(themeName)), swatch, t.fg("muted", "·"), t.fg("dim", "code")].join(" ");
}

export class ThemeSelectorComponent extends Container {
	private selectList: SelectList;
	private onPreview: (themeName: string) => void;
	private readonly originalTheme: string;

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super();
		this.onPreview = onPreview;
		this.originalTheme = currentTheme;

		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			// The description renders in the theme's CURRENT colors (the
			// active theme when the selector opened), which is good enough
			// as a "neutral" preview. Per-theme real-time preview happens
			// via the side effect below: the parent's onPreview handler
			// applies the new theme, so subsequent frames re-render with
			// the new colors.
			description: buildPreviewLine(name),
		}));

		// Sort: light themes first (grouped), then dark, then system-default.
		themeItems.sort((a, b) => {
			const aLight = isLightTheme(a.value) ? 0 : 1;
			const bLight = isLightTheme(b.value) ? 0 : 1;
			if (aLight !== bLight) return aLight - bLight;
			return a.value.localeCompare(b.value);
		});

		this.addChild(new DynamicBorder());

		this.selectList = new SelectList(themeItems, 12, getSelectListTheme(), THEME_SELECT_LIST_LAYOUT);

		const currentIndex = themeItems.findIndex((i) => i.value === currentTheme);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};
		this.selectList.onCancel = () => {
			// Roll back to the original theme on cancel.
			this.onPreview(this.originalTheme);
			onCancel();
		};
		this.selectList.onSelectionChange = (item) => {
			this.onPreview(item.value);
		};

		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	/** Exposed for symmetry with the prior implementation. */
	getSelectList(): SelectList {
		return this.selectList;
	}
}

/**
 * Helper: open a ThemeSelectorComponent as a focus-stealing overlay. The
 * caller is responsible for wiring `onPreview` to the theme controller's
 * preview path and `onSelect` to the commit path.
 */
export function showThemeSelector(
	tui: TUI,
	currentTheme: string,
	onSelect: (themeName: string) => void,
	onCancel: () => void,
	onPreview: (themeName: string) => void,
): { component: Component; close: () => void } {
	const component = new ThemeSelectorComponent(currentTheme, onSelect, onCancel, onPreview);
	// import lazily to keep this module's surface small.
	const handle = tui.showOverlay(component, {
		anchor: "center",
		width: "70%",
		minWidth: 60,
		maxHeight: "70%",
		margin: 1,
	});
	return { component, close: () => handle.hide() };
}
