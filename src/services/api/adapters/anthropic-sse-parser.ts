import type { DomainStreamEvent } from "../../../types/domain.js";
import {
	anthropicStreamEventToDomain,
	type WireStreamEvent,
} from "../../../types/domainConversion.js";
import type { NormalizedApiError } from "../../../utils/normalizedError.js";
import type { ProviderType } from "../../../utils/settings/types.js";
import { DomainTransportError } from "../domain-errors.js";

export async function* parseAnthropicSSEStream(
	body: ReadableStream<Uint8Array>,
	providerType: ProviderType,
	normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): AsyncGenerator<DomainStreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				buffer += decoder.decode();
				if (buffer.trim()) {
					buffer += "\n";
				}
			} else {
				buffer += decoder.decode(value, { stream: true });
			}

			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (trimmed.startsWith("event:")) continue;
				if (!trimmed.startsWith("data: ")) continue;

				const dataStr = trimmed.slice(6);
				if (dataStr === "[DONE]") continue;

				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(dataStr);
				} catch {
					continue;
				}

				if (parsed.type === "error") {
					const normalized = normalizeError(
						{ body: parsed, status: undefined },
						providerType,
					);
					throw new DomainTransportError({
						normalized,
						raw: parsed,
					});
				}

				if (parsed.type === "ping") continue;

				yield anthropicStreamEventToDomain(parsed as WireStreamEvent);
			}

			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}
