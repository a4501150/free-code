/**
 * Anthropic-native adapter.
 *
 * The only adapter that uses `@anthropic-ai/sdk`. All SDK-specific
 * helpers (error wrapping, stream conversion) are private to this file.
 *
 * For streaming, uses raw `Stream<BetaRawMessageStreamEvent>` (not
 * `BetaMessageStream`) to avoid O(n²) partial JSON parsing in tool input
 * accumulation.
 */
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
	BetaMessageStreamParams,
	BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type { Stream } from "@anthropic-ai/sdk/streaming.mjs";
import type { DomainStreamEvent } from "../../../types/domain.js";
import {
	anthropicMessageToDomain,
	anthropicStreamEventToDomain,
	type WireStreamEvent,
} from "../../../types/domainConversion.js";
import {
	fromHttpStatus,
	type NormalizedApiError,
} from "../../../utils/normalizedError.js";
import type {
	ProviderCapabilities,
	ProviderConfig,
	ProviderType,
} from "../../../utils/settings/types.js";
import { countTokensViaAnthropicEndpoint } from "../../tokenEstimation.js";
import type {
	ProviderAdapter,
	TokenBreakdown,
	TokenCountMessageParam,
	TokenCountToolParam,
} from "../adapter.js";
import { getAnthropicClient } from "../client.js";
import {
	DomainConnectionError,
	DomainConnectionTimeoutError,
	DomainTransportError,
	DomainUserAbortError,
} from "../domain-errors.js";
import type {
	DomainMessageRequest,
	DomainMessageResponse,
	DomainStreamingResponse,
} from "../domain-transport.js";
import { buildAnthropicWireBody } from "./anthropic-wire-body.js";

// ── SDK-specific helpers (private to this adapter) ───────────────────

function wrapSdkError(
	error: unknown,
	providerType: ProviderType,
	normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): never {
	if (error instanceof DomainTransportError) throw error;
	if (error instanceof DomainUserAbortError) throw error;

	if (error instanceof APIUserAbortError) {
		throw new DomainUserAbortError();
	}

	if (error instanceof APIConnectionTimeoutError) {
		const normalized = normalizeError(
			{ cause: error, mid_stream: true },
			providerType,
		);
		throw new DomainConnectionTimeoutError({
			normalized: { ...normalized, kind: "transport" },
			cause: error,
			raw: error,
		});
	}

	if (error instanceof APIConnectionError) {
		const normalized = normalizeError(
			{ cause: error, mid_stream: true },
			providerType,
		);
		throw new DomainConnectionError({
			normalized: { ...normalized, kind: "transport" },
			cause: error,
			raw: error,
		});
	}

	if (error instanceof APIError) {
		const normalized = normalizeError(
			{
				status: error.status,
				body: (error as unknown as { error?: unknown }).error ?? error.message,
				headers: error.headers,
			},
			providerType,
		);
		const headers = error.headers
			? Object.fromEntries(error.headers.entries())
			: undefined;
		throw new DomainTransportError({
			normalized,
			status: error.status,
			requestID: error.requestID ?? undefined,
			headers,
			raw: error,
		});
	}

	const normalized: NormalizedApiError = {
		kind: "transport",
		message: error instanceof Error ? error.message : String(error),
		providerType,
		raw: error,
	};
	throw new DomainConnectionError({
		normalized,
		cause: error,
		raw: error,
	});
}

function makeStreamingResponse(
	sdkStream: Stream<BetaRawMessageStreamEvent>,
	sdkResponse: Response | undefined,
	requestId: string | null | undefined,
	providerType: ProviderType,
	normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): DomainStreamingResponse {
	async function* convertEvents(): AsyncGenerator<DomainStreamEvent> {
		try {
			for await (const event of sdkStream) {
				yield anthropicStreamEventToDomain(event as unknown as WireStreamEvent);
			}
		} catch (error) {
			if (error instanceof DomainUserAbortError) throw error;
			if (error instanceof DomainTransportError) throw error;

			if (error instanceof APIUserAbortError) {
				throw new DomainUserAbortError();
			}

			wrapSdkError(error, providerType, normalizeError);
		}
	}

	const responseHeaders = sdkResponse?.headers
		? Object.fromEntries(sdkResponse.headers.entries())
		: undefined;

	return {
		stream: convertEvents(),
		requestId: requestId ?? undefined,
		responseHeaders,
		abort() {
			sdkStream.controller.abort();
		},
		release() {
			try {
				sdkStream.controller.abort();
			} catch {
				// ignore
			}
			if (sdkResponse?.body) {
				sdkResponse.body.cancel().catch(() => {});
			}
		},
	};
}

// ── Adapter ──────────────────────────────────────────────────────────

export const anthropicAdapter: ProviderAdapter = {
	providerType: "anthropic",
	capabilities: {} as ProviderCapabilities,

	async createStream(
		_config: ProviderConfig,
		request: DomainMessageRequest,
		signal: AbortSignal,
	): Promise<DomainStreamingResponse> {
		const client = await getAnthropicClient({
			maxRetries: 0,
			model: request.model,
			source: "adapter",
		});
		const params = buildAnthropicWireBody(
			request,
		) as unknown as BetaMessageStreamParams;

		try {
			const result = await client.beta.messages
				.create(
					{ ...params, stream: true },
					{
						signal,
						...(request.clientRequestId && {
							headers: { "x-client-request-id": request.clientRequestId },
						}),
					},
				)
				.withResponse();
			return makeStreamingResponse(
				result.data,
				result.response,
				result.request_id,
				"anthropic",
				this.normalizeError,
			);
		} catch (error) {
			wrapSdkError(error, "anthropic", this.normalizeError);
		}
	},

	async createMessage(
		config: ProviderConfig,
		request: DomainMessageRequest,
		signal: AbortSignal,
	): Promise<DomainMessageResponse> {
		const configApiKey = config.auth?.apiKey?.key;
		const client = await getAnthropicClient({
			maxRetries: 0,
			model: request.model,
			source: "adapter",
			...(configApiKey && { apiKey: configApiKey }),
		});
		const params = buildAnthropicWireBody(
			request,
		) as unknown as BetaMessageStreamParams;

		try {
			const result = await client.beta.messages
				.create(
					{ ...params, stream: false },
					{
						signal,
						...(request.clientRequestId && {
							headers: { "x-client-request-id": request.clientRequestId },
						}),
					},
				)
				.withResponse();
			return {
				message: anthropicMessageToDomain(
					result.data as unknown as Parameters<
						typeof anthropicMessageToDomain
					>[0],
				),
				requestId: result.request_id ?? undefined,
				responseHeaders: Object.fromEntries(result.response.headers.entries()),
			};
		} catch (error) {
			wrapSdkError(error, "anthropic", this.normalizeError);
		}
	},

	async countTokens(
		messages: TokenCountMessageParam[],
		tools: TokenCountToolParam[],
		model: string,
		options?: { system?: string; betas?: string[] },
	): Promise<TokenBreakdown | null> {
		const inputTokens = await countTokensViaAnthropicEndpoint({
			messages,
			tools,
			model,
			betas: options?.betas ?? [],
			system: options?.system,
		});
		if (inputTokens == null) return null;
		return { inputTokens, outputTokens: 0 };
	},

	normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
		const r = (raw ?? {}) as {
			status?: number;
			body?: unknown;
			headers?: Headers | Record<string, string>;
			mid_stream?: boolean;
			cause?: unknown;
		};
		let innerType: string | undefined;
		let innerMessage: string | undefined;
		if (r.body) {
			try {
				const parsed =
					typeof r.body === "string"
						? (JSON.parse(r.body) as {
								error?: { type?: string; message?: string };
							})
						: (r.body as { error?: { type?: string; message?: string } });
				innerType = parsed?.error?.type;
				innerMessage = parsed?.error?.message;
			} catch {
				// body is not JSON; leave undefined.
			}
		}

		if (typeof r.status === "number") {
			const base = fromHttpStatus(
				r.status,
				innerMessage ??
					(typeof r.body === "string" ? r.body : `HTTP ${r.status}`),
				providerType,
				r.headers,
				raw,
			);
			if (innerType === "overloaded_error") {
				return { ...base, kind: "overloaded" };
			}
			if (innerType === "rate_limit_error") {
				return { ...base, kind: "rate_limit" };
			}
			return base;
		}

		if (innerType === "overloaded_error") {
			return {
				kind: "overloaded",
				message: innerMessage ?? "overloaded",
				providerType,
				raw,
			};
		}
		if (innerType === "rate_limit_error") {
			return {
				kind: "rate_limit",
				message: innerMessage ?? "rate limited",
				providerType,
				raw,
			};
		}
		const causeMsg =
			r.cause instanceof Error
				? r.cause.message
				: String(r.cause ?? "stream error");
		return {
			kind: "transport",
			message: innerMessage ?? causeMsg,
			providerType,
			raw,
		};
	},
};
