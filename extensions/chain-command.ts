/**
 * Chain Command Extension — `/chain <name> [input]` runs a declarative
 * chain (see .pi/chains/*.yaml) by instructing the model to invoke the
 * `chain` tool. `/chain` with no args lists available chains.
 */

import { type ExtensionAPI, getAgentDir, loadChains } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("chain", {
		description: "Run a multi-agent chain: /chain <name> [input] · /chain new <desc>",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const loaded = loadChains({ cwd: process.cwd(), agentDir: getAgentDir() });
			if (trimmed === "new") {
				ctx.ui.notify("Usage: /chain new <description of the workflow>", "error");
				return;
			}
			if (trimmed.startsWith("new ")) {
				const description = trimmed.slice(4).trim();
				pi.sendUserMessage(
					`Create a new chain YAML file at .pi/chains/<short-name>.yaml implementing this workflow: ${description}\n\n` +
						"Schema: name (required), description, optional budget_usd, optional inputs (name -> {description, default}), " +
						"stages: [{id, agent (explore|plan|worker|reviewer or custom), prompt (may use {{input}}, {{inputs.x}}, " +
						"{{stageId.result}}, {{stageId.handle}}, {{item}}), optional model, needs, verify (shell), " +
						"judge (question), foreach (list template), max_items, max_iters, on_fail: stop|continue}]. " +
						"foreach cannot combine with verify/judge on the same stage. " +
						"Write the file, show it to me, and briefly explain each stage. Do NOT run it yet.",
				);
				return;
			}
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
