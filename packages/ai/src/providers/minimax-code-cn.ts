import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_CODE_CN_MODELS } from "./minimax-code-cn.models.ts";

function tokenPlanAuth(name: string, envVars: readonly string[], authUrl: string): ApiKeyAuth {
	return {
		name,
		login: async (callbacks) => {
			callbacks.notify({
				type: "auth_url",
				url: authUrl,
				instructions: "Subscribe to MiniMax Token Plan, then paste the generated API key.",
			});
			const key = await callbacks.prompt({
				type: "secret",
				message: `Paste your ${name}`,
				placeholder: "sk-...",
			});
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}
/** MiniMax Token Plan (China) — subscription API over OpenAI-compatible /v1. */
export function minimaxCodeCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "minimax-code-cn",
		name: "MiniMax Token Plan CN",
		baseUrl: "https://api.minimaxi.com/v1",
		auth: {
			apiKey: tokenPlanAuth(
				"MiniMax Token Plan CN API key",
				["MINIMAX_CODE_CN_API_KEY", "MINIMAX_CN_API_KEY"],
				"https://platform.minimaxi.com/subscribe/token-plan",
			),
		},
		models: Object.values(MINIMAX_CODE_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
