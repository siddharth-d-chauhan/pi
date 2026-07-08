/**
 * lsp-rename.ts — semantic rename + find-references via a real LSP client.
 *
 * The one true gap vs Claude Code (oh-my-pi's LSP stops at navigation; opencode's
 * is off-by-default). This spawns a language server, does the JSON-RPC handshake,
 * and runs textDocument/rename — a project-wide semantic rename that updates every
 * reference correctly (not a text find-replace), plus textDocument/references.
 *
 * Minimal but correct LSP client over stdio (Content-Length framed JSON-RPC 2.0):
 * initialize → initialized → didOpen(target) → rename/references → apply the
 * returned WorkspaceEdit to disk → shutdown. One server process per request
 * (simple + robust; rename isn't hot).
 *
 * Servers are AUTO-DETECTED (rank 23) via the shared lsp-registry: a language
 * server is picked only when its rootMarker is present in the tree AND its binary
 * resolves — preferring project-local bins (node_modules/.bin, .venv/bin) over
 * global PATH. Only TYPE-INTEL servers (not diagnostics-only linters) are used for
 * rename/references. Rough coverage:
 *   .ts/.tsx/.js  → typescript-language-server (rootMarker: tsconfig/package.json)
 *   .py           → pyright-langserver / pylsp   (rootMarker: pyproject/setup.py)
 *   .rs           → rust-analyzer                (rootMarker: Cargo.toml)
 *   .go           → gopls                        (rootMarker: go.mod)
 * Override via .pi/lsp.json { "<ext>": {"command":[...]} }.
 *
 * Config: KP_LSP_ENABLED=0 · KP_LSP_TIMEOUT_MS (default 45s).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { typeIntelServerFor } from "./lsp-registry.ts";

const ENABLED = process.env.KP_LSP_ENABLED !== "0";
const TIMEOUT = Number(process.env.KP_LSP_TIMEOUT_MS || 45_000);

// ext → type-intel server launch command via the autodetect registry (rootMarker
// ∩ binary, project-local bins preferred). Diagnostics-only linters are excluded —
// rename/references need a type-intel server. .pi/lsp.json overrides win.
function serverFor(file: string, cwd: string): string[] | null {
	try {
		const cfgPath = resolve(cwd, ".pi", "lsp.json");
		if (existsSync(cfgPath)) {
			const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
			const e = extname(file).toLowerCase();
			const ov = cfg?.[e]?.command;
			if (Array.isArray(ov) && ov.length) return ov;
		}
	} catch {}
	return typeIntelServerFor(file, cwd);
}

// minimal LSP client: run one request lifecycle and return the result.
function lspRequest(file: string, cwd: string, method: string, targetParams: (uri: string) => any): Promise<any> {
	return new Promise((resolve_, reject) => {
		const cmd = serverFor(file, cwd);
		if (!cmd)
			return reject(
				new Error(
					`no type-intel language server for ${extname(file)} (need rootMarker + binary; project-local bins preferred)`,
				),
			);
		const abs = resolve(cwd, file);
		const uri = pathToFileURL(abs).href;
		const proc = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let buf = Buffer.alloc(0);
		let id = 0;
		const pending = new Map<number, (v: any) => void>();
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error("LSP timeout"));
		}, TIMEOUT);

		const send = (msg: any) => {
			const body = Buffer.from(JSON.stringify(msg));
			proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
			proc.stdin.write(body);
		};
		const request = (m: string, params: any) =>
			new Promise<any>((res) => {
				const rid = ++id;
				pending.set(rid, res);
				send({ jsonrpc: "2.0", id: rid, method: m, params });
			});
		const notify = (m: string, params: any) => send({ jsonrpc: "2.0", method: m, params });

		proc.stdout.on("data", (d) => {
			buf = Buffer.concat([buf, d]);
			for (;;) {
				const headerEnd = buf.indexOf("\r\n\r\n");
				if (headerEnd < 0) break;
				const header = buf.slice(0, headerEnd).toString();
				const m = header.match(/Content-Length:\s*(\d+)/i);
				if (!m) {
					buf = buf.slice(headerEnd + 4);
					continue;
				}
				const len = Number(m[1]);
				const start = headerEnd + 4;
				if (buf.length < start + len) break;
				const body = buf.slice(start, start + len).toString();
				buf = buf.slice(start + len);
				let msg: any;
				try {
					msg = JSON.parse(body);
				} catch {
					continue;
				}
				if (msg.id != null && pending.has(msg.id)) {
					pending.get(msg.id)!(msg.result ?? msg.error ?? null);
					pending.delete(msg.id);
				}
				// server→client requests we must answer to proceed
				else if (msg.method === "workspace/configuration")
					send({ jsonrpc: "2.0", id: msg.id, result: (msg.params?.items ?? []).map(() => ({})) });
				else if (msg.method === "client/registerCapability") send({ jsonrpc: "2.0", id: msg.id, result: null });
				else if (msg.method === "window/workDoneProgress/create")
					send({ jsonrpc: "2.0", id: msg.id, result: null });
			}
		});
		proc.stderr.on("data", () => {});
		proc.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});

		(async () => {
			try {
				await request("initialize", {
					processId: process.pid,
					rootUri: pathToFileURL(cwd).href,
					capabilities: {
						textDocument: { rename: { dynamicRegistration: false, prepareSupport: false }, references: {} },
						workspace: { workspaceEdit: { documentChanges: true } },
					},
				});
				notify("initialized", {});
				const text = readFileSync(abs, "utf-8");
				notify("textDocument/didOpen", {
					textDocument: { uri, languageId: extname(file).slice(1), version: 1, text },
				});
				await new Promise((r) => setTimeout(r, 1200)); // let the server index
				const result = await request(method, targetParams(uri));
				clearTimeout(timer);
				try {
					await request("shutdown", null);
					notify("exit", {});
				} catch {}
				proc.kill();
				resolve_(result);
			} catch (e) {
				clearTimeout(timer);
				proc.kill();
				reject(e);
			}
		})();
	});
}

// find a symbol's position (line, char) in a file — first occurrence of the name.
function findSymbol(abs: string, name: string): { line: number; character: number } | null {
	const lines = readFileSync(abs, "utf-8").split("\n");
	const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	for (let i = 0; i < lines.length; i++) {
		const c = lines[i].search(re);
		if (c >= 0) return { line: i, character: c };
	}
	return null;
}

// apply a WorkspaceEdit (changes or documentChanges) to disk.
function applyWorkspaceEdit(edit: any): { files: number; edits: number } {
	let files = 0,
		edits = 0;
	const perFile: Record<string, any[]> = {};
	if (edit?.changes) for (const [uri, es] of Object.entries(edit.changes)) perFile[uri] = es as any[];
	if (edit?.documentChanges)
		for (const dc of edit.documentChanges)
			if (dc.textDocument?.uri && dc.edits) perFile[dc.textDocument.uri] = dc.edits;
	for (const [uri, es] of Object.entries(perFile)) {
		const path = fileURLToPath(uri);
		if (!existsSync(path)) continue;
		const lines = readFileSync(path, "utf-8").split("\n");
		// apply edits bottom-up so positions stay valid
		const sorted = [...es].sort(
			(a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
		);
		for (const ed of sorted) {
			const { start, end } = ed.range;
			const sL = lines[start.line] ?? "";
			if (start.line === end.line)
				lines[start.line] = sL.slice(0, start.character) + ed.newText + sL.slice(end.character);
			else {
				const eL = lines[end.line] ?? "";
				const merged = sL.slice(0, start.character) + ed.newText + eL.slice(end.character);
				lines.splice(start.line, end.line - start.line + 1, merged);
			}
			edits++;
		}
		writeFileSync(path, lines.join("\n"));
		files++;
	}
	return { files, edits };
}

export default function (pi: any) {
	if (!ENABLED) return;

	pi.registerTool({
		name: "rename_symbol",
		label: "rename",
		description:
			"Semantic project-wide rename of a symbol (function/variable/class/type) — updates EVERY reference correctly " +
			"via the language server, not a text find-replace. path + old_name + new_name. Supports TS/JS, Python, Rust, Go " +
			"(needs the language server; TS/Py auto-install via npx).",
		promptSnippet: "rename_symbol(path, old_name, new_name) — semantic project-wide rename via LSP",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, old_name: { type: "string" }, new_name: { type: "string" } },
			required: ["path", "old_name", "new_name"],
		},
		async execute(_id: string, p: any) {
			const cwd = process.cwd();
			const abs = resolve(cwd, p.path);
			if (!existsSync(abs)) return { content: [{ type: "text", text: `no such file: ${p.path}` }], isError: true };
			const pos = findSymbol(abs, p.old_name);
			if (!pos)
				return {
					content: [{ type: "text", text: `symbol '${p.old_name}' not found in ${p.path}` }],
					isError: true,
				};
			try {
				const edit = await lspRequest(abs, cwd, "textDocument/rename", (uri) => ({
					textDocument: { uri },
					position: pos,
					newName: p.new_name,
				}));
				if (!edit || edit.code)
					return {
						content: [
							{
								type: "text",
								text: `rename failed: ${edit?.message ?? "no edit returned (symbol may not be renameable here)"}`,
							},
						],
						isError: true,
					};
				const { files, edits } = applyWorkspaceEdit(edit);
				return {
					content: [
						{
							type: "text",
							text: `Renamed '${p.old_name}' → '${p.new_name}': ${edits} references across ${files} file(s).`,
						},
					],
				};
			} catch (e: any) {
				return { content: [{ type: "text", text: `rename error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "find_references",
		label: "find refs",
		description:
			"Find all references to a symbol project-wide via the language server (semantic, not grep). path + name.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, name: { type: "string" } },
			required: ["path", "name"],
		},
		async execute(_id: string, p: any) {
			const cwd = process.cwd();
			const abs = resolve(cwd, p.path);
			if (!existsSync(abs)) return { content: [{ type: "text", text: `no such file: ${p.path}` }], isError: true };
			const pos = findSymbol(abs, p.name);
			if (!pos) return { content: [{ type: "text", text: `symbol '${p.name}' not found` }], isError: true };
			try {
				const refs = await lspRequest(abs, cwd, "textDocument/references", (uri) => ({
					textDocument: { uri },
					position: pos,
					context: { includeDeclaration: true },
				}));
				if (!Array.isArray(refs) || !refs.length)
					return { content: [{ type: "text", text: "no references found" }] };
				const list = refs
					.slice(0, 50)
					.map((r: any) => `${fileURLToPath(r.uri).replace(`${cwd}/`, "")}:${r.range.start.line + 1}`)
					.join("\n");
				return { content: [{ type: "text", text: `${refs.length} references to '${p.name}':\n${list}` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `references error: ${e.message}` }], isError: true };
			}
		},
	});
}
