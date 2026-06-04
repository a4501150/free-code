import { GoogleAuth } from "google-auth-library";
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from "../../../constants/betas.js";
import {
	anthropicMessageToDomain,
	type WireMessage,
} from "../../../types/domainConversion.js";
import { refreshGcpCredentialsIfNeeded } from "../../../utils/auth.js";
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

async function getVertexAccessToken(
	config: ProviderConfig,
): Promise<{ token: string; projectId?: string }> {
	if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
		return { token: "", projectId: config.auth?.gcp?.projectId };
	}

	await refreshGcpCredentialsIfNeeded();

	const hasProjectEnvVar =
		process.env["GCLOUD_PROJECT"] ||
		process.env["GOOGLE_CLOUD_PROJECT"] ||
		process.env["gcloud_project"] ||
		process.env["google_cloud_project"];
	const hasKeyFile =
		process.env["GOOGLE_APPLICATION_CREDENTIALS"] ||
		process.env["google_application_credentials"];

	const googleAuth = new GoogleAuth({
		scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		...(hasProjectEnvVar || hasKeyFile
			? {}
			: { projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID }),
	});

	const authClient = await googleAuth.getClient();
	const headers = (await authClient.getRequestHeaders()) as unknown as Record<
		string,
		string | undefined
	>;
	const token = headers["Authorization"]?.replace("Bearer ", "") || "";
	const projectId =
		headers["x-goog-user-project"] ||
		(await googleAuth.getProjectId()) ||
		undefined;
	return { token, projectId: projectId ?? undefined };
}

// ── URL helpers ──────────────────────────────────────────────────────

function getVertexBaseUrl(config: ProviderConfig): string {
	const region = config.auth?.gcp?.region || "us-east5";
	return (
		config.baseUrl ||
		(region === "global"
			? "https://aiplatform.googleapis.com/v1"
			: `https://${region}-aiplatform.googleapis.com/v1`)
	);
}

function getVertexUrl(
	baseUrl: string,
	projectId: string,
	region: string,
	model: string,
	action: string,
): string {
	return `${baseUrl.replace(/\/$/, "")}/projects/${projectId}/locations/${region}/publishers/anthropic/models/${model}:${action}`;
}

// ── Body transform ───────────────────────────────────────────────────

function applyVertexTransforms(body: Record<string, unknown>): {
	model: string;
	body: Record<string, unknown>;
} {
	const model = body.model as string;
	const vertexBody = { ...body };
	delete vertexBody.model;
	vertexBody.anthropic_version = "vertex-2023-10-16";

	if (vertexBody.betas) {
		vertexBody.anthropic_beta = vertexBody.betas;
		delete vertexBody.betas;
	}

	return { model, body: vertexBody };
}

// ── Adapter ──────────────────────────────────────────────────────────

export const vertexAnthropicAdapter: ProviderAdapter = {
	providerType: "vertex",

	async createStream(
		config: ProviderConfig,
		request: DomainMessageRequest,
		signal: AbortSignal,
		fetchOverride?: typeof globalThis.fetch,
	): Promise<DomainStreamingResponse> {
		const fetch = fetchOverride ?? globalThis.fetch;
		const region = config.auth?.gcp?.region || "us-east5";
		const baseUrl = getVertexBaseUrl(config);
		const authResult = await getVertexAccessToken(config);
		const projectId = config.auth?.gcp?.projectId || authResult.projectId || "";

		const wireBody = buildAnthropicWireBody(request);
		wireBody.stream = true;
		const { model, body: vertexBody } = applyVertexTransforms(wireBody);

		const url = getVertexUrl(
			baseUrl,
			projectId,
			region,
			model,
			"streamRawPredict",
		);

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authResult.token}`,
					...(request.clientRequestId && {
						"x-client-request-id": request.clientRequestId,
					}),
				},
				body: JSON.stringify(vertexBody),
				signal,
			});
		} catch (error) {
			handleFetchError(error, signal, "vertex", this.normalizeError);
		}

		await assertOkResponse(response, "vertex", this.normalizeError);

		const responseBody = assertResponseBody(response, "vertex");
		const stream = parseAnthropicSSEStream(
			responseBody,
			"vertex",
			this.normalizeError,
		);

		return makeStreamingResponse({
			response,
			stream,
			requestIdHeader: "x-request-id",
		});
	},

	async createMessage(
		config: ProviderConfig,
		request: DomainMessageRequest,
		signal: AbortSignal,
		fetchOverride?: typeof globalThis.fetch,
	): Promise<DomainMessageResponse> {
		const fetch = fetchOverride ?? globalThis.fetch;
		const region = config.auth?.gcp?.region || "us-east5";
		const baseUrl = getVertexBaseUrl(config);
		const authResult = await getVertexAccessToken(config);
		const projectId = config.auth?.gcp?.projectId || authResult.projectId || "";

		const wireBody = buildAnthropicWireBody(request);
		wireBody.stream = false;
		const { model, body: vertexBody } = applyVertexTransforms(wireBody);

		const url = getVertexUrl(baseUrl, projectId, region, model, "rawPredict");

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authResult.token}`,
					...(request.clientRequestId && {
						"x-client-request-id": request.clientRequestId,
					}),
				},
				body: JSON.stringify(vertexBody),
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
				"vertex",
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
				"vertex",
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
			requestId: response.headers.get("x-request-id") ?? undefined,
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
			if (!resolved || resolved.config.type !== "vertex") return null;

			const config = resolved.config;
			const region = config.auth?.gcp?.region || "us-east5";
			const baseUrl = getVertexBaseUrl(config);
			const authResult = await getVertexAccessToken(config);
			const projectId =
				config.auth?.gcp?.projectId || authResult.projectId || "";

			const betas = options?.betas ?? [];
			const filteredBetas = betas.filter((b) =>
				VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b),
			);
			const containsThinking = hasThinkingBlocks(messages);
			const normalizedModel = normalizeModelStringForAPI(model);

			const body: Record<string, unknown> = {
				anthropic_version: "vertex-2023-10-16",
				messages:
					messages.length > 0 ? messages : [{ role: "user", content: "foo" }],
				model: normalizedModel,
				tools,
				...(options?.system && { system: options.system }),
				...(filteredBetas.length > 0 && { anthropic_beta: filteredBetas }),
				...(containsThinking && {
					thinking: {
						type: "enabled",
						budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
					},
					max_tokens: TOKEN_COUNT_MAX_TOKENS,
				}),
			};

			const countTokensUrl = `${baseUrl.replace(/\/$/, "")}/projects/${projectId}/locations/${region}/publishers/anthropic/models/${normalizedModel}:countTokens`;

			const response = await globalThis.fetch(countTokensUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authResult.token}`,
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
