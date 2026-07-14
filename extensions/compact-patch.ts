import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatch } from "diff";
import { Type } from "typebox";

const PatchParameters = Type.Object({
	path: Type.String({ description: "File to modify, relative to the working directory or absolute." }),
	patch: Type.String({
		description:
			"Unified diff hunks for this file. Headers are optional. Include only changed lines and 2-3 context lines.",
	}),
});

const NUMBERED_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface HunkRange {
	oldStart: number;
	oldCount: number;
	newCount: number;
}

function hunkBodyCounts(lines: string[]): { oldLines: string[]; oldCount: number; newCount: number } {
	const oldLines: string[] = [];
	let oldCount = 0;
	let newCount = 0;
	for (const line of lines) {
		if (line.startsWith("\\ No newline at end of file")) continue;
		if (line.startsWith(" ")) {
			oldLines.push(line.slice(1));
			oldCount += 1;
			newCount += 1;
		} else if (line.startsWith("-")) {
			oldLines.push(line.slice(1));
			oldCount += 1;
		} else if (line.startsWith("+")) {
			newCount += 1;
		} else if (line !== "") {
			throw new Error(`Invalid unified-diff line '${line.slice(0, 80)}'. Prefix context with a space.`);
		}
	}
	return { oldLines, oldCount, newCount };
}

function findUniqueSequence(haystack: string[], needle: string[]): number {
	if (needle.length === 0) {
		throw new Error("A headerless add-only hunk needs at least one unchanged or removed context line.");
	}
	const matches: number[] = [];
	for (let start = 0; start + needle.length <= haystack.length; start += 1) {
		if (needle.every((line, offset) => haystack[start + offset] === line)) matches.push(start);
	}
	if (matches.length === 0) {
		throw new Error("Headerless patch context did not match the current file. Read the affected range and retry.");
	}
	if (matches.length > 1) {
		throw new Error("Headerless patch context is ambiguous. Include 2-3 more unchanged context lines.");
	}
	return matches[0];
}

/** Convert model-friendly bare `@@` hunks into strict unified ranges by exact,
 * unique context matching. This keeps the compact schema without fuzzy edits. */
export function normalizeCompactPatch(original: string, patch: string): string {
	const patchLines = patch.replace(/\r\n/g, "\n").split("\n");
	if (!patchLines.some((line) => line === "@@")) return patch;
	const originalLines = original.replace(/\r\n/g, "\n").split("\n");
	let cumulativeDelta = 0;
	let previousOldEnd = 0;

	for (let index = 0; index < patchLines.length; index += 1) {
		const header = patchLines[index];
		if (!header.startsWith("@@")) continue;
		let bodyEnd = index + 1;
		while (bodyEnd < patchLines.length && !patchLines[bodyEnd].startsWith("@@")) bodyEnd += 1;
		const body = patchLines.slice(index + 1, bodyEnd);
		while (body.at(-1) === "") body.pop();

		const numbered = NUMBERED_HUNK.exec(header);
		let range: HunkRange;
		if (numbered) {
			range = {
				oldStart: Number(numbered[1]),
				oldCount: Number(numbered[2] ?? 1),
				newCount: Number(numbered[4] ?? 1),
			};
		} else if (header === "@@") {
			const counts = hunkBodyCounts(body);
			const oldStart = findUniqueSequence(originalLines, counts.oldLines) + 1;
			range = { oldStart, oldCount: counts.oldCount, newCount: counts.newCount };
			patchLines[index] =
				`@@ -${range.oldStart},${range.oldCount} +${range.oldStart + cumulativeDelta},${range.newCount} @@`;
		} else {
			throw new Error(`Invalid unified-diff hunk header '${header.slice(0, 80)}'.`);
		}

		if (range.oldStart < previousOldEnd) {
			throw new Error("Patch hunks must appear in file order and must not overlap.");
		}
		previousOldEnd = range.oldStart + range.oldCount;
		cumulativeDelta += range.newCount - range.oldCount;
		index = bodyEnd - 1;
	}
	return patchLines.join("\n");
}

/**
 * A token-lean edit surface. Unlike the built-in exact-replacement tool, a
 * unified hunk does not repeat the complete old and new blocks in JSON.
 */
export default function compactPatch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "apply_patch",
		label: "apply patch",
		description: "Apply strict unified-diff hunks to one existing file.",
		promptSnippet: "Apply compact unified-diff hunks to an existing file",
		promptGuidelines: [
			"Prefer apply_patch for existing files: send only changed lines with 2-3 context lines. Use write only for new files or complete rewrites.",
		],
		parameters: PatchParameters,
		async execute(_toolCallId, { path, patch }, signal, _onUpdate, ctx) {
			const absolutePath = resolve(ctx.cwd, path);
			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				const original = await readFile(absolutePath, "utf8");
				if (signal?.aborted) throw new Error("Operation aborted");
				const normalizedPatch = normalizeCompactPatch(original, patch);
				const updated = applyPatch(original, normalizedPatch, { fuzzFactor: 0 });
				if (updated === false) {
					throw new Error(
						"Patch did not match the current file. Read only the affected range and retry with current context.",
					);
				}
				if (updated === original) throw new Error("Patch made no changes.");
				await writeFile(absolutePath, updated, "utf8");
				if (signal?.aborted) throw new Error("Operation aborted");
				return {
					content: [
						{
							type: "text",
							text: `Applied patch to ${path} (${updated.length - original.length >= 0 ? "+" : ""}${updated.length - original.length} bytes).`,
						},
					],
					details: undefined,
				};
			});
		},
	});

	// Keep one stable mutation schema for the whole session. Per-turn tool
	// switching would save schema bytes but destroy provider prompt-cache reuse.
	pi.on("session_start", async () => {
		if (process.env.PI_COMPACT_PATCH === "0") return;
		const active = pi.getActiveTools();
		if (!active.includes("apply_patch") || !active.includes("edit")) return;
		pi.setActiveTools(active.filter((name) => name !== "edit"));
	});
}
