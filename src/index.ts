import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadWebsearchConfig } from "./websearch/config.js";
import { resolveNativeAdapter } from "./websearch/native.js";
import { providerEntryLabel } from "./websearch/search.js";
import { createWebSearchTool } from "./websearch/tool.js";
import type { ConfigLoadResult, WebsearchConfig } from "./websearch/types.js";

const STATUS_KEY = "pi-websearch";
const WIDGET_KEY = "pi-websearch";
const MISSING_CONFIG_MESSAGE =
	"Missing websearch config. Create .pi/websearch.json or ~/.pi/websearch.json before starting pi.";

export default function (pi: ExtensionAPI): void {
	let state: ConfigLoadResult = {
		ok: false,
		reason: "missing_config",
		message: MISSING_CONFIG_MESSAGE,
	};

	function providerList(config: WebsearchConfig): string {
		return config.providers.map(providerEntryLabel).join(", ");
	}

	function clearUi(ctx: ExtensionContext): void {
		if (ctx.hasUI === false) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (ctx.hasUI === false) return;
		clearUi(ctx);
		if (!state.ok) ctx.ui.notify(state.message, "error");
	}

	function activeModelLabel(ctx: ExtensionContext): string {
		if (!ctx.model) return "no active model";
		return `${ctx.model.provider}/${ctx.model.id}`;
	}

	function nativeStatusLabel(ctx: ExtensionContext, config: WebsearchConfig): string {
		if (!config.auto) return "native=disabled (auto=false)";
		const inspection = resolveNativeAdapter(ctx.model, config.nativeOverrides);
		if (inspection.status.status === "ready") {
			const adapter = inspection.adapter ?? inspection.status.adapter ?? "unknown";
			const model = inspection.model ?? inspection.status.model;
			return model ? `native=ready adapter=${adapter} model=${model}` : `native=ready adapter=${adapter}`;
		}
		return `native=skipped (${inspection.status.reason ?? "active model has no server-hosted search adapter"})`;
	}

	function statusMessage(ctx: ExtensionContext): { message: string; level: "info" | "error" } {
		if (!state.ok) {
			return { message: `Web search inactive: ${state.message}`, level: "error" };
		}
		const config = state.config;
		return {
			message: [
				"Web search active:",
				`model=${activeModelLabel(ctx)}`,
				`auto=${config.auto ? "enabled" : "disabled"}`,
				`rawMode=${config.rawMode === true ? "enabled" : "disabled"}`,
				nativeStatusLabel(ctx, config),
				`strategy=${config.strategy}`,
				`fallback=${config.fallback ? "enabled" : "disabled"}`,
				`providers=${providerList(config)}`,
			].join(", "),
			level: "info",
		};
	}

	pi.registerTool(createWebSearchTool(() => state));

	pi.on("session_start", async (_event, ctx) => {
		state = await loadWebsearchConfig({ cwd: ctx.cwd });
		// Re-register after loading config so raw mode is absent unless explicitly enabled.
		pi.registerTool(createWebSearchTool(() => state));
		updateUi(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		// The tool resolves model and auth from the context of each call, so only the UI is refreshed here.
		clearUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearUi(ctx);
	});

	pi.registerCommand("websearch", {
		description: "Show web search provider status",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (args !== "" && args !== "status") {
				ctx.ui.notify("Usage: /websearch status", "warning");
				return;
			}
			const status = statusMessage(ctx);
			ctx.ui.notify(status.message, status.level);
		},
	});
}
