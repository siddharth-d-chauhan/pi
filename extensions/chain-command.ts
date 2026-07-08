/**
 * Chain Command Extension — `/chain <name> [input]` runs a declarative
 * chain (see .pi/chains/*.yaml) by instructing the model to invoke the
 * `chain` tool. `/chain` with no args lists available chains.
 */

import { type ExtensionAPI, getAgentDir, loadChains } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("chain", {
		description: "Run a multi-agent chain: /chain <name> [input]",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const loaded = loadChains({ cwd: process.cwd(), agentDir: getAgentDir() });
			if (!trimmed) {
				const names = [...loaded.chains.values()]
					.map((chain) => `${chain.name} — ${chain.description ?? chain.filePath}`)
					.join("\n");
				ctx.ui.notify(names.length > 0 ? `Chains:\n${names}` : "No chains defined (.pi/chains/*.yaml)", "info");
				return;
			}
			const [name, ...rest] = trimmed.split(/\s+/);
			const input = rest.join(" ");
			if (!loaded.chains.has(name.toLowerCase())) {
				ctx.ui.notify(`Unknown chain "${name}". Known: ${[...loaded.chains.keys()].join(", ") || "none"}`, "error");
				return;
			}
			pi.sendUserMessage(
				`Run the chain "${name}"${input ? ` with input: ${input}` : ""} using the chain tool. ` +
					"Report the final stage's result.",
			);
		},
	});
}
