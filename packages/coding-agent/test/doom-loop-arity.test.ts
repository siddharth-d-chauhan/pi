import { beforeAll, expect, test } from "vitest";
import { commandPrefix, normalizeCommand } from "../../../extensions/lib/arity.ts";

// --- arity extractor -----------------------------------------------------

test("commandPrefix keeps the subcommand, drops the variable tail", () => {
	expect(commandPrefix('git commit -m "some message"')).toBe("git commit");
	expect(commandPrefix("git status")).toBe("git status");
	expect(commandPrefix("git push origin main")).toBe("git push");
	expect(commandPrefix("npm test")).toBe("npm test");
	// "run" earns one deeper token — the script name is the operation
	expect(commandPrefix("npm run build --silent")).toBe("npm run build");
	expect(commandPrefix("docker compose up -d")).toBe("docker compose up");
	// unknown tool → base only
	expect(commandPrefix("cat /etc/hosts")).toBe("cat");
});

test("commandPrefix strips leading env assignments and sudo", () => {
	expect(commandPrefix("NODE_ENV=prod npm run build")).toBe("npm run build");
	expect(commandPrefix("sudo systemctl restart nginx")).toBe("systemctl restart");
});

test("normalizeCommand collapses compound commands into a stable op signature", () => {
	const a = normalizeCommand('git add -A && git commit -m "a" && git push origin main');
	const b = normalizeCommand('git add . && git commit -m "totally different" && git push origin dev');
	// same operations, different args -> identical normalized signature
	expect(a).toBe(b);
	expect(a).toBe("git add ; git commit ; git push");
});

// --- doom-loop guard (arity-normalized) ----------------------------------

type Handler = (e: unknown) => Promise<{ block?: boolean; reason?: string }>;
let mod: { default: (pi: unknown) => void };

beforeAll(async () => {
	process.env.KP_DOOMLOOP = "3"; // small threshold for a fast test
	mod = await import("../../../extensions/doom-loop.ts");
});

// Each call to default() builds a fresh closure with its own thrash window, so a
// new handler per test = isolated state without re-importing the module.
function freshHandler(): (command: string) => Promise<{ block?: boolean; reason?: string }> {
	const handlers: Handler[] = [];
	mod.default({
		on: (e: string, h: Handler) => {
			if (e === "tool_call") handlers.push(h);
		},
		registerCommand() {},
	});
	const h = handlers[0];
	return (command: string) => h({ toolName: "bash", input: { command } });
}

test("identical operations trip the guard at the threshold — arity-normalized", async () => {
	const bash = freshHandler();
	// three commits with DIFFERENT messages: raw strings differ, operation is the same
	expect((await bash('git commit -m "first"')).block).toBeFalsy();
	expect((await bash('git commit -m "second"')).block).toBeFalsy();
	const r3 = await bash('git commit -m "third"');
	expect(r3.block).toBe(true);
	expect(r3.reason).toContain("same operation");
});

test("varied, progressing operations do NOT trip the guard", async () => {
	const bash = freshHandler();
	expect((await bash("git status")).block).toBeFalsy();
	expect((await bash("npm test")).block).toBeFalsy();
	expect((await bash("git add -A")).block).toBeFalsy();
	expect((await bash('git commit -m "x"')).block).toBeFalsy();
	expect((await bash("git push")).block).toBeFalsy();
});

test("A/B alternation trips the guard", async () => {
	const bash = freshHandler();
	// A B A B A B -> 2N=6 window, 2 distinct, current present -> trip
	await bash("git status");
	await bash("npm test");
	await bash("git status");
	await bash("npm test");
	await bash("git status");
	const last = await bash("npm test");
	expect(last.block).toBe(true);
	expect(last.reason).toContain("cycling");
});
