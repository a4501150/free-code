import {
	DefaultAzureCredential as AzureCredential,
	getBearerTokenProvider,
} from "@azure/identity";
import {
	anthropicMessageToDomain,
	type WireMessage,
} from "../../../types/domainConversion.js";
import { isEnvTruthy } from "../../../utils/envUtils.js";
import { logError } from "../../../utils/log.js";
import { normalizeModelStringForAPI } from "../../../utils/model/modelResolution.js";
import {
	getProviderRegistry,
	type ResolvedProvider,
} from "../../../utils/model/providerRegistry.js";
import type { NormalizedApiError } from "../../../utils/normalizedError.js";
import type {
	ProviderConfig,
	ProviderType,
} from "../../../utils/settings/types.js";
import {
	hasThinkingBlocks,
	TOKEN_COUNT_MAX_TOKENS,
	TOKEN_COUNT_THINKING_BUDGET,
	type ProviderAdapter,
	type TokenBreakdown,
	type TokenCountMessageParam,
	type TokenCountToolParam,
} from "../adapter.js";
import {
	DomainConnectionError,
	DomainTransportError,
	DomainUserAbortError,
} from "../domain-errors.js";
import type {
	DomainMessageRequest,
	DomainMessageResponse,
	DomainStreamingResponse,
} from "../domain-transport.js";
import { anthropicAdapter } from "./anthropic-adapter-impl.js";
import { parseAnthropicSSEStream } from "./anthropic-sse-parser.js";
import { buildAnthropicWireBody } from "./anthropic-wire-body.js";
import {
	assertOkResponse,
	assertResponseBody,
	handleFetchError,
	makeStreamingResponse,
} from "./native-fetch-helpers.js";

// ── Auth ─────────────────────────────────────────────────────────────

async function getFoundryAuth(
	config: ProviderConfig,
): Promise<{ headerName: string; headerValue: string }> {
	const auth = config.auth;
	if (auth?.active === "apiKey") {
		const key =
			auth.apiKey?.key ||
			(auth.apiKey?.keyEnv ? process.env[auth.apiKey.keyEnv] : undefined);
		if (key) return { headerName: "x-api-key", headerValue: key };
	}

	if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
		return { headerName: "x-api-key", headerValue: "" };
	}

	const tokenProvider = getBearerTokenProvider(
		new AzureCredential(),
		"https://cognitiveservices.azure.com/.default",
	);
	const token = await tokenProvider();
	return { headerName: "Authorization", headerValue: `Bearer ${token}` };
}

// ── Adapter ──────────────────────────────────────────────────────────

export const foundryAdapter: ProviderAdapter = {
	providerType: "foundry",

	async createStream(
		config: ProviderConfig,
		request: DomainMessageRequest,
		signal: AbortSignal,
		fetchOverride?: typeof globalThis.fetch,
	): Promise<DomainStreamingResponse> {
		const fetch = fetchOverride ?? globalThis.fetch;
		const baseUrl = config.baseUrl || "";
		const { headerName, headerValue } = await getFoundryAuth(config);

		const wireBody = buildAnthropicWireBody(request);
		wireBody.stream = true;

		const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
					[headerName]: headerValue,
					...(request.clientRequestId && {
						"x-client-request-id": request.clientRequestId,
					}),
				},
				body: JSON.stringify(wireBody),
				signal,
			});
		} catch (error) {
			handleFetchError(error, signal, "foundry", this.normalizeError);
		}

		await assertOkResponse(response, "foundry", this.normalizeError);

		const responseBody = assertResponseBody(response, "foundry");
		const stream = parseAnthropicSSEStream(
			responseBody,
			"foundry",
			this.normalizeError,
		);

		return makeStreamingResponse({
			response,
			stream,
			requestIdHeader: "request-id",
		});
	},

	async createMessage(
		config: ProviderConfig,
		request: DomainMessageRequest,
		signal: AbortSignal,
		fetchOverride?: typeof globalThis.fetch,
	): Promise<DomainMessageResponse> {
		const fetch = fetchOverride ?? globalThis.fetch;
		const baseUrl = config.baseUrl || "";
		const { headerName, headerValue } = await getFoundryAuth(config);

		const wireBody = buildAnthropicWireBody(request);
		wireBody.stream = false;

		const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
					[headerName]: headerValue,
					...(request.clientRequestId && {
						"x-client-request-id": request.clientRequestId,
					}),
				},
				body: JSON.stringify(wireBody),
				signal,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.name === "AbortError" || signal.aborted)
			) {
				throw new DomainUserAbortError();
			}
			const normalized = this.normalizeError(
				{ cause: error, mid_stream: false },
				"foundry",
			);
			throw new DomainConnectionError({
				normalized: { ...normalized, kind: "transport" },
				cause: error,
				raw: error,
			});
		}

		if (!response.ok) {
			const errorText = await response.text();
			const normalized = this.normalizeError(
				{ status: response.status, body: errorText, headers: response.headers },
				"foundry",
			);
			throw new DomainTransportError({
				normalized,
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
				raw: { status: response.status, body: errorText },
			});
		}

		const json = (await response.json()) as WireMessage;
		return {
			message: anthropicMessageToDomain(json),
			requestId: response.headers.get("request-id") ?? undefined,
			responseHeaders: Object.fromEntries(response.headers.entries()),
		};
	},

	async countTokens(
		messages: TokenCountMessageParam[],
		tools: TokenCountToolParam[],
		model: string,
		options?: { system?: string; betas?: string[] },
	): Promise<TokenBreakdown | null> {
		try {
			const resolved = getProviderRegistry().getProviderForModel(
				model,
			) as ResolvedProvider | null;
			if (!resolved || resolved.config.type !== "foundry") return null;

			const config = resolved.config;
			const baseUrl = config.baseUrl || "";
			const { headerName, headerValue } = await getFoundryAuth(config);

			const betas = options?.betas ?? [];
			const containsThinking = hasThinkingBlocks(messages);

			const url = `${baseUrl.replace(/\/$/, "")}/v1/messages/count_tokens`;
			const body: Record<string, unknown> = {
				model: normalizeModelStringForAPI(model),
				messages:
					messages.length > 0 ? messages : [{ role: "user", content: "foo" }],
				tools,
				...(options?.system && { system: options.system }),
				...(betas.length > 0 && { betas }),
				...(containsThinking && {
					thinking: {
						type: "enabled",
						budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
					},
					max_tokens: TOKEN_COUNT_MAX_TOKENS,
				}),
			};

			const response = await globalThis.fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
					[headerName]: headerValue,
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) return null;

			const json = (await response.json()) as Record<string, unknown>;
			if (typeof json.input_tokens !== "number") return null;
			return { inputTokens: json.input_tokens, outputTokens: 0 };
		} catch (error) {
			logError(error);
			return null;
		}
	},

	normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
		return anthropicAdapter.normalizeError(raw, providerType);
	},
};
