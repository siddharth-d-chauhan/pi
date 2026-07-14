/**
 * ECC Extension — mounts the ECC content library (github.com/affaan-m/ECC:
 * ~94 slash-command playbooks, ~278 skills, ~67 agent personas) into pi as
 * ON-DEMAND prompts. Nothing is injected until you ask: `/ecc <command>` loads
 * exactly one command file, `/ecc skill <name>` exactly one SKILL.md.
 *
 * Central install (`~/.pi/ecc`, override PI_ECC_HOME) — content is markdown,
 * no engine or build step. ECC's hooks/rules/session-start layers are NOT
 * wired: pi already owns those concerns (doom-loop, token-budget, auto-learn,
 * KP). A small preamble maps Claude-Code tool names the prompts occasionally
 * mention (Task/TodoWrite/AskUserQuestion) onto pi's equivalents.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function eccHome(): string {
	return process.env.PI_ECC_HOME ?? join(homedir(), ".pi", "ecc");
}

const ADAPTER_PREAMBLE =
	"<ecc-adapter>This playbook was written for Claude Code. Tool mapping for pi: " +
	'"Task tool"/subagents → the agent tool; "TodoWrite" → update_plan; "AskUserQuestion" → ask the user in plain text and wait. ' +
	"Ignore instructions about hooks or settings files.</ecc-adapter>";

/** Frontmatter description of a command/skill markdown file (cheap parse). */
export function frontmatterDescription(source: string): string {
	const match = /^---\n[\s\S]*?\bdescription:\s*(.+?)\n[\s\S]*?---/m.exec(source);
	return match ? match[1].trim() : "";
}

/** Substitute the ECC $ARGUMENTS placeholder; append args when absent. */
export function fillArguments(source: string, args: string): string {
	if (source.includes("$ARGUMENTS")) return source.replaceAll("$ARGUMENTS", args || "(none)");
	return args ? `${source}\n\n**Input**: ${args}` : source;
}

function commandPath(name: string): string {
	return join(eccHome(), "commands", `${name}.md`);
}

function skillPath(name: string): string {
	return join(eccHome(), "skills", name, "SKILL.md");
}

function listNames(dir: string, stripMd: boolean): string[] {
	try {
		return readdirSync(join(eccHome(), dir))
			.filter((entry) => !entry.startsWith("."))
			.map((entry) => (stripMd ? entry.replace(/\.md$/, "") : entry))
			.filter((entry) => entry !== "README")
			.sort();
	} catch {
		return [];
	}
}

/** Concatenate a rules dir's markdown files (name-tagged), size-capped. */
export function collectRules(home: string, lang: string, maxChars = 60_000): string {
	const parts: string[] = [];
	for (const dir of ["common", lang]) {
		const root = join(home, "rules", dir);
		let files: string[] = [];
		try {
			files = readdirSync(root)
				.filter((entry) => entry.endsWith(".md"))
				.sort();
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				parts.push(`## rules/${dir}/${file}\n${readFileSync(join(root, file), "utf-8").trim()}`);
			} catch {
				// unreadable file — skip
			}
		}
	}
	return parts.join("\n\n").slice(0, maxChars);
}

/** Case-insensitive name/description search over commands and skills. */
export function searchLibrary(home: string, term: string): string[] {
	const needle = term.toLowerCase();
	const hits: string[] = [];
	const probe = (kind: string, name: string, file: string) => {
		try {
			const source = readFileSync(file, "utf-8");
			const description = frontmatterDescription(source);
			if (name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle)) {
				hits.push(`${kind} ${name} — ${description.slice(0, 90)}`);
			}
		} catch {
			// unreadable entry — skip
		}
	};
	for (const name of listNames("commands", true)) probe("command", name, join(home, "commands", `${name}.md`));
	for (const name of listNames("skills", false)) probe("skill", name, join(home, "skills", name, "SKILL.md"));
	return hits;
}

export default function ecc(pi: ExtensionAPI) {
	pi.registerCommand("ecc", {
		description: "Run an ECC playbook on demand: /ecc <command> [args] · skill <name> · list · search <term> · setup",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const [sub = "", ...rest] = raw.split(/\s+/);
			const restText = rest.join(" ");

			if (sub === "setup") {
				if (existsSync(join(eccHome(), "commands"))) {
					ctx.ui.notify(`ECC already installed at ${eccHome()}`, "info");
					return;
				}
				ctx.ui.notify("cloning affaan-m/ECC…", "info");
				const cloned = await new Promise<boolean>((resolve) => {
					execFile(
						"git",
						["clone", "--depth", "1", "https://github.com/affaan-m/ECC", eccHome()],
						{ timeout: 600_000 },
						(error) => resolve(!error),
					);
				});
				ctx.ui.notify(
					cloned
						? `ECC installed at ${eccHome()} — /ecc list to browse`
						: "clone failed — check network/git, or set PI_ECC_HOME to an existing checkout",
					cloned ? "info" : "error",
				);
				return;
			}
			if (!existsSync(join(eccHome(), "commands"))) {
				ctx.ui.notify(`ECC not found at ${eccHome()} — run /ecc setup`, "error");
				return;
			}
			if (sub === "" || sub === "list") {
				const commands = listNames("commands", true);
				const skills = listNames("skills", false);
				ctx.ui.notify(
					`ECC: ${commands.length} commands, ${skills.length} skills.\n` +
						`Commands: ${commands.slice(0, 40).join(", ")}${commands.length > 40 ? ", …" : ""}\n` +
						"Use /ecc <command> [args] · /ecc skill <name> · /ecc search <term>",
					"info",
				);
				return;
			}
			if (sub === "search") {
				if (!restText) {
					ctx.ui.notify("Usage: /ecc search <term>", "error");
					return;
				}
				const hits = searchLibrary(eccHome(), restText);
				ctx.ui.notify(
					hits.length > 0 ? hits.slice(0, 25).join("\n") : `no ECC entries match "${restText}"`,
					"info",
				);
				return;
			}
			if (sub === "rules") {
				const lang = rest[0];
				const available = listNames("rules", false).filter((name) => name !== "common");
				if (!lang || !existsSync(join(eccHome(), "rules", lang))) {
					ctx.ui.notify(`Usage: /ecc rules <lang> — available: ${available.join(", ")}`, lang ? "error" : "info");
					return;
				}
				const rules = collectRules(eccHome(), lang);
				pi.sendUserMessage(
					`<ecc-rules lang="${lang}">\n${rules}\n</ecc-rules>\n` +
						"These are the project conventions to follow for this language from here on. " +
						"Acknowledge briefly and apply them to subsequent work; do not repeat them back.",
				);
				return;
			}
			if (sub === "skill") {
				const name = rest[0];
				if (!name || !existsSync(skillPath(name))) {
					ctx.ui.notify(`unknown ECC skill "${name ?? ""}" — /ecc search <term> to find one`, "error");
					return;
				}
				const source = readFileSync(skillPath(name), "utf-8");
				pi.sendUserMessage(
					`${ADAPTER_PREAMBLE}\n<ecc-skill name="${name}">\n${source}\n</ecc-skill>\n` +
						`Apply this skill to the current task${rest.slice(1).length ? `: ${rest.slice(1).join(" ")}` : "."}`,
				);
				return;
			}
			if (!existsSync(commandPath(sub))) {
				ctx.ui.notify(`unknown ECC command "${sub}" — /ecc list or /ecc search <term>`, "error");
				return;
			}
			const source = readFileSync(commandPath(sub), "utf-8");
			pi.sendUserMessage(`${ADAPTER_PREAMBLE}\n${fillArguments(source, restText)}`);
		},
	});
}
