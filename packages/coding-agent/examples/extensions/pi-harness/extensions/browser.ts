/**
 * browser.ts — headless browser automation over raw Chrome DevTools Protocol (CDP).
 *
 * ZERO npm deps: launches your installed Chrome with --remote-debugging-port and drives it via
 * Node 22's native WebSocket + fetch. No puppeteer, no bundled Chromium. Fastest path (direct CDP,
 * no wrapper library). One persistent Chrome + page per session, reused across tool calls.
 *
 * Tools:
 *   browser_open(url)                  → navigate the page (launches Chrome on first use).
 *   browser_read([selector])          → text content of the page (or a selector), + the URL/title.
 *   browser_click(selector)           → click the first match.
 *   browser_type(selector, text, [enter]) → focus + type into an input (optionally press Enter).
 *   browser_eval(js)                  → run JS in the page, return the (JSON-able) result.
 *   browser_screenshot([path],[full]) → PNG of the viewport (or full page) to a file.
 *   browser_record(action,[path])     → start/stop a screencast → mp4 via ffmpeg (on-demand).
 *   browser_close()                   → shut the browser down.
 *
 * Headless by default (KP_BROWSER_HEADFUL=1 for a visible window). Recording is on-demand
 * (Page.startScreencast frames → ffmpeg). Chrome is killed on session_shutdown.
 *
 * Config: KP_BROWSER_ENABLED=0 disable · KP_BROWSER_BIN (chrome path) · KP_BROWSER_HEADFUL=1 ·
 *   KP_BROWSER_PORT (default 9412).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.KP_BROWSER_ENABLED !== "0";
const HEADFUL = process.env.KP_BROWSER_HEADFUL === "1";
const PORT = Number(process.env.KP_BROWSER_PORT || 9412);
const CHROME_BIN = process.env.KP_BROWSER_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = join(tmpdir(), "pi-browser-profile");
const FRAME_DIR = join(tmpdir(), "pi-browser-frames");

export default function (pi: any) {
	if (!ENABLED) return;

	let proc: ChildProcess | null = null;
	let ws: WebSocket | null = null;
	let sessionId: string | null = null;
	let msgId = 0;
	const pending = new Map<number, (m: any) => void>();
	let recording: { frames: number; fps: number } | null = null;

	// --- minimal CDP client (native WebSocket) ------------------------------------------------
	function connect(wsUrl: string): Promise<void> {
		return new Promise((res, rej) => {
			ws = new WebSocket(wsUrl);
			ws.addEventListener("open", () => res());
			ws.addEventListener("error", () => rej(new Error("CDP socket error")));
			ws.addEventListener("message", (ev: any) => {
				let m: any;
				try {
					m = JSON.parse(ev.data);
				} catch {
					return;
				}
				if (m.id != null && pending.has(m.id)) {
					pending.get(m.id)!(m);
					pending.delete(m.id);
				} else if (m.method === "Page.screencastFrame") onFrame(m.params);
			});
		});
	}
	function send(method: string, params: any = {}, useSession = true): Promise<any> {
		return new Promise((res, rej) => {
			if (!ws) return rej(new Error("browser not open"));
			const id = ++msgId;
			pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
			ws.send(JSON.stringify({ id, method, params, ...(useSession && sessionId ? { sessionId } : {}) }));
		});
	}
	const page = (method: string, params?: any) => send(method, params, true);

	async function ensureBrowser(): Promise<void> {
		if (ws && sessionId) return;
		if (!existsSync(CHROME_BIN)) throw new Error(`Chrome not found at ${CHROME_BIN} (set KP_BROWSER_BIN)`);
		try {
			mkdirSync(PROFILE, { recursive: true });
		} catch {}
		const args = [
			...(HEADFUL ? [] : ["--headless=new"]),
			`--remote-debugging-port=${PORT}`,
			`--user-data-dir=${PROFILE}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"about:blank",
		];
		proc = spawn(CHROME_BIN, args, { stdio: "ignore" });
		proc.on("exit", () => {
			proc = null;
			ws = null;
			sessionId = null;
		});
		// poll CDP http endpoint for the browser ws url
		let ver: any = null;
		for (let i = 0; i < 40; i++) {
			try {
				const r = await fetch(`http://localhost:${PORT}/json/version`);
				ver = await r.json();
				if (ver.webSocketDebuggerUrl) break;
			} catch {}
			await new Promise((r) => setTimeout(r, 200));
		}
		if (!ver?.webSocketDebuggerUrl) throw new Error("Chrome CDP did not come up");
		await connect(ver.webSocketDebuggerUrl);
		const { targetId } = await send("Target.createTarget", { url: "about:blank" }, false);
		const attach = await send("Target.attachToTarget", { targetId, flatten: true }, false);
		sessionId = attach.sessionId;
		await page("Page.enable");
		await page("Runtime.enable");
		await page("DOM.enable");
	}

	async function waitLoad(ms = 1200): Promise<void> {
		await new Promise((r) => setTimeout(r, ms));
	}

	// evaluate JS in the page, return the value by-value
	async function evalJs(expression: string): Promise<any> {
		const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
		return r.result?.value;
	}

	// --- recording: screencast frames → ffmpeg ------------------------------------------------
	let frameSeq = 0;
	function onFrame(p: any): void {
		if (!recording) return;
		try {
			writeFileSync(join(FRAME_DIR, `f${String(++frameSeq).padStart(6, "0")}.jpg`), Buffer.from(p.data, "base64"));
			recording.frames++;
		} catch {}
		// ACK is mandatory: Chrome pauses the screencast until each frame is acked. p.sessionId is the
		// SCREENCAST frame session id (an int), distinct from the CDP sessionId — must be passed as the
		// ack param while STILL routing over our CDP session. Without this only the first frame arrives.
		void page("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
	}

	// --- tools --------------------------------------------------------------------------------
	const ok = (text: string) => ({ content: [{ type: "text", text }] });
	const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });

	pi.registerTool({
		name: "browser_open",
		label: "browser open",
		description:
			"Open a URL in a headless browser (launches Chrome on first use). Persists across " +
			"calls — subsequent browser_* tools act on this page. Returns the final URL + title.",
		promptSnippet:
			"browser_open(url) — navigate a headless browser; browser_read/click/type/eval/screenshot to drive it",
		parameters: {
			type: "object",
			properties: { url: { type: "string", description: "the URL to open" } },
			required: ["url"],
		},
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				await page("Page.navigate", { url: String(params?.url || "") });
				await waitLoad();
				const info = await evalJs("({url: location.href, title: document.title})");
				return ok(`opened ${info.url}\ntitle: ${info.title}`);
			} catch (e: any) {
				return err(`browser_open: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_read",
		label: "browser read",
		description:
			"Read the current page's visible text (or a CSS selector's text). Returns URL + title " +
			"+ text. Use to see what's on the page before/after an action.",
		promptSnippet: "browser_read([selector]) — the page's (or a selector's) visible text",
		parameters: {
			type: "object",
			properties: { selector: { type: "string", description: "optional CSS selector (default: whole body)" } },
		},
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				const sel = params?.selector ? JSON.stringify(String(params.selector)) : null;
				const expr = sel
					? `(()=>{const el=document.querySelector(${sel});return el?({url:location.href,title:document.title,text:el.innerText}):({error:'no match for '+${sel}})})()`
					: `({url:location.href,title:document.title,text:document.body?document.body.innerText:''})`;
				const r = await evalJs(expr);
				if (r?.error) return err(r.error);
				const text = String(r.text || "").slice(0, 8000);
				return ok(
					`${r.url}\n${r.title}\n\n${text}${(r.text || "").length > 8000 ? "\n…[truncated — use browser_eval for more]" : ""}`,
				);
			} catch (e: any) {
				return err(`browser_read: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_click",
		label: "browser click",
		description: "Click the first element matching a CSS selector.",
		promptSnippet: "browser_click(selector) — click an element",
		parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				const sel = JSON.stringify(String(params?.selector || ""));
				const r = await evalJs(
					`(()=>{const el=document.querySelector(${sel});if(!el)return{ok:false};el.click();return{ok:true}})()`,
				);
				await waitLoad(500);
				return r?.ok ? ok(`clicked ${params.selector}`) : err(`no element matches ${params.selector}`);
			} catch (e: any) {
				return err(`browser_click: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_type",
		label: "browser type",
		description: "Type text into an input/textarea matched by a CSS selector; optionally press Enter after.",
		promptSnippet: "browser_type(selector, text, [enter]) — type into an input",
		parameters: {
			type: "object",
			properties: {
				selector: { type: "string" },
				text: { type: "string" },
				enter: { type: "boolean", description: "press Enter after typing" },
			},
			required: ["selector", "text"],
		},
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				const sel = JSON.stringify(String(params?.selector || ""));
				const val = JSON.stringify(String(params?.text || ""));
				const r = await evalJs(
					`(()=>{const el=document.querySelector(${sel});if(!el)return{ok:false};el.focus();el.value=${val};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true}})()`,
				);
				if (!r?.ok) return err(`no input matches ${params.selector}`);
				if (params?.enter) {
					for (const type of ["keyDown", "keyUp"])
						await page("Input.dispatchKeyEvent", {
							type,
							key: "Enter",
							code: "Enter",
							windowsVirtualKeyCode: 13,
						});
					await waitLoad();
				}
				return ok(`typed into ${params.selector}${params?.enter ? " + Enter" : ""}`);
			} catch (e: any) {
				return err(`browser_type: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_wait",
		label: "browser wait",
		description:
			"Wait until a CSS selector appears (or a JS condition becomes true), up to timeout. " +
			"Essential for LONG/async tasks — SPA content that loads after navigation, a spinner clearing, " +
			"a result row appearing. Polls in-page so it doesn't burn tool calls. Returns when ready or times out.",
		promptSnippet: "browser_wait(selector | condition_js, [timeout_s]) — block until an element/condition is ready",
		parameters: {
			type: "object",
			properties: {
				selector: { type: "string", description: "CSS selector to wait for" },
				condition_js: {
					type: "string",
					description: "JS expression that should become truthy (alternative to selector)",
				},
				timeout_s: { type: "integer", description: "max seconds (default 30)" },
			},
		},
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				const timeout = Math.max(1, Number(params?.timeout_s || 30)) * 1000;
				const test = params?.selector
					? `!!document.querySelector(${JSON.stringify(String(params.selector))})`
					: `!!(${String(params?.condition_js || "true")})`;
				const start = Date.now();
				// poll IN-PAGE every 250ms so a slow load doesn't cost the agent tool calls
				while (Date.now() - start < timeout) {
					let ready = false;
					try {
						ready = (await evalJs(test)) === true;
					} catch {}
					if (ready) return ok(`ready after ${Math.round((Date.now() - start) / 100) / 10}s`);
					await new Promise((r) => setTimeout(r, 250));
				}
				return err(
					`timed out after ${Math.round(timeout / 1000)}s waiting for ${params?.selector || params?.condition_js}`,
				);
			} catch (e: any) {
				return err(`browser_wait: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_eval",
		label: "browser eval",
		description:
			"Run JavaScript in the page and return the (JSON-serializable) result. For anything " +
			"the higher-level tools don't cover — extract structured data, wait for a condition, etc.",
		promptSnippet: "browser_eval(js) — run JS in the page, get the result",
		parameters: {
			type: "object",
			properties: { js: { type: "string", description: "a JS expression (its value is returned)" } },
			required: ["js"],
		},
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				const v = await evalJs(String(params?.js || ""));
				return ok(typeof v === "string" ? v : JSON.stringify(v));
			} catch (e: any) {
				return err(`browser_eval: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "browser screenshot",
		description:
			"Capture a PNG screenshot of the page to a file. full=true captures the entire " +
			"scrollable page (default: just the viewport).",
		promptSnippet: "browser_screenshot([path],[full]) — PNG of the page to a file",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "output file (default: a temp .png)" },
				full: { type: "boolean", description: "capture the full scrollable page" },
			},
		},
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				const shot = await page("Page.captureScreenshot", {
					format: "png",
					captureBeyondViewport: params?.full === true,
				});
				const path = String(params?.path || join(tmpdir(), `pi-shot-${Date.now()}.png`));
				writeFileSync(path, Buffer.from(shot.data, "base64"));
				return ok(`screenshot → ${path}`);
			} catch (e: any) {
				return err(`browser_screenshot: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_record",
		label: "browser record",
		description:
			"Record a video of the browser. action='start' begins a screencast; action='stop' " +
			"ends it and encodes the captured frames to an mp4 via ffmpeg at `path`. On-demand — off by " +
			"default. Requires ffmpeg on PATH.",
		promptSnippet: "browser_record('start'|'stop', [path]) — record the browser session to mp4 (needs ffmpeg)",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["start", "stop"] },
				path: { type: "string", description: "output mp4 (for stop; default: a temp .mp4)" },
			},
			required: ["action"],
		},
		async execute(_id: string, params: any) {
			try {
				await ensureBrowser();
				if (params?.action === "start") {
					if (recording) return ok("already recording");
					try {
						mkdirSync(FRAME_DIR, { recursive: true });
					} catch {}
					// clear old frames
					try {
						for (const f of require("node:fs").readdirSync(FRAME_DIR))
							require("node:fs").rmSync(join(FRAME_DIR, f));
					} catch {}
					frameSeq = 0;
					recording = { frames: 0, fps: 10 };
					await page("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
					return ok("recording started — do your browser actions, then browser_record('stop', path)");
				}
				// stop
				if (!recording) return err("not recording");
				await page("Page.stopScreencast");
				const rec = recording;
				recording = null;
				if (!rec.frames) return err("no frames captured");
				const path = String(params?.path || join(tmpdir(), `pi-rec-${Date.now()}.mp4`));
				// Robust encode: even-dimension scale filter (libx264 requires it), and -r to force a
				// steady output rate even from few/uneven screencast frames (they arrive only on visual
				// change, so a mostly-static session yields few — pad to a watchable clip).
				await new Promise<void>((res, rej) => {
					let ffErr = "";
					const ff = spawn(
						"ffmpeg",
						[
							"-y",
							"-framerate",
							String(rec.fps),
							"-i",
							join(FRAME_DIR, "f%06d.jpg"),
							"-vf",
							"scale=trunc(iw/2)*2:trunc(ih/2)*2",
							"-r",
							String(rec.fps),
							"-c:v",
							"libx264",
							"-pix_fmt",
							"yuv420p",
							path,
						],
						{ stdio: ["ignore", "ignore", "pipe"] },
					);
					ff.stderr?.on("data", (d) => {
						ffErr += d.toString();
					});
					ff.on("exit", (c) =>
						c === 0
							? res()
							: rej(new Error(`ffmpeg exit ${c}: ${ffErr.split("\n").slice(-3).join(" ").slice(0, 200)}`)),
					);
					ff.on("error", (e) => rej(e));
				});
				return ok(`recording → ${path} (${rec.frames} frames @ ${rec.fps}fps)`);
			} catch (e: any) {
				return err(`browser_record: ${e?.message || e}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_close",
		label: "browser close",
		description: "Close the browser and free its resources.",
		promptSnippet: "browser_close() — shut the headless browser down",
		parameters: { type: "object", properties: {} },
		async execute() {
			try {
				ws?.close();
			} catch {}
			try {
				proc?.kill();
			} catch {}
			ws = null;
			sessionId = null;
			proc = null;
			recording = null;
			return ok("browser closed");
		},
	});

	pi.on("session_shutdown", async () => {
		try {
			ws?.close();
		} catch {}
		try {
			proc?.kill();
		} catch {}
	});
}
