/**
 * exit.ts — /exit and /q as aliases for pi's built-in /quit.
 *
 * pi's native quit command is /quit; this adds the more common /exit (and /q)
 * muscle-memory aliases so either works. Calls ctx.shutdown() — a graceful exit,
 * the same path /quit uses.
 *
 * Config: KP_EXIT_ENABLED=0 disable.
 */

const ENABLED = process.env.KP_EXIT_ENABLED !== "0";

export default function (pi: any) {
	if (!ENABLED) return;

	const quit = (_label: string) => ({
		description: `Exit pi (alias for /quit).`,
		handler: async (_args: string, ctx: any) => {
			try {
				ctx.ui?.notify?.("Exiting pi…", "info");
			} catch {}
			try {
				ctx.shutdown?.();
			} catch {
				try {
					(globalThis as any).process?.exit?.(0);
				} catch {}
			}
		},
	});

	pi.registerCommand("exit", quit("exit"));
	pi.registerCommand("q", quit("q"));
}
