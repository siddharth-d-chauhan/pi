/**
 * Icons Extension — switch the icon tier used by the production extensions
 * (dashboard, orchestra, agent status, cards).
 *
 *   /icons            show current mode + choices
 *   /icons nerd       Nerd Font glyphs (needs a patched terminal font —
 *                     if you see boxes/tofu, switch back)
 *   /icons emoji      emoji tier
 *   /icons unicode    safe default
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getIconMode, type IconMode, icon, setIconMode } from "./lib/icons.ts";

const MODES: IconMode[] = ["unicode", "nerd", "emoji"];

export default function (pi: ExtensionAPI) {
	pi.registerCommand("icons", {
		description: "Switch icon style: /icons [unicode|nerd|emoji]",
		handler: async (args, ctx) => {
			const requested = (args ?? "").trim().toLowerCase() as IconMode;
			if (MODES.includes(requested)) {
				setIconMode(requested);
				const sample = `${icon("team")} ${icon("chain")} ${icon("agent")} ${icon("branch")} ${icon("ok")} ${icon("speed")}`;
				ctx.ui.notify(
					`Icons: ${requested}  ${sample}${requested === "nerd" ? "  (boxes/tofu? your font isn't Nerd-patched — /icons unicode)" : ""}`,
					"info",
				);
				return;
			}
			const current = getIconMode();
			const rows = MODES.map((mode) => `${mode === current ? "* " : "  "}${mode}`).join("\n");
			ctx.ui.notify(`Icon modes (/icons <mode>):\n${rows}`, "info");
		},
	});
}
