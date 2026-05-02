import { waitFor, type WaitForOptions } from './wait-helpers'

export type RequestLogServer<TRequest> = {
  getRequestLog(): TRequest[]
  getRequestCount(): number
}

export async function waitForRequestCount<TRequest>(
  server: RequestLogServer<TRequest>,
  minCount: number,
  options: WaitForOptions = {},
): Promise<TRequest[]> {
  return waitFor(
    () => server.getRequestLog(),
    requests => requests.length >= minCount,
    {
      ...options,
      description: options.description ?? `${minCount} mock server request(s)`,
      onTimeout:
        options.onTimeout ??
        (() =>
          requestLogSummary(server.getRequestLog(), server.getRequestCount())),
    },
  )
}

export async function waitForRequest<TRequest>(
  server: RequestLogServer<TRequest>,
  predicate: (
    request: TRequest,
    index: number,
    requests: TRequest[],
  ) => boolean,
  options: WaitForOptions = {},
): Promise<TRequest> {
  const requests = await waitForRequestLog(
    server,
    requests =>
      requests.some((request, index) => predicate(request, index, requests)),
    options,
  )
  const request = requests.find((entry, index) =>
    predicate(entry, index, requests),
  )
  if (!request) {
    throw new Error(
      'waitForRequest predicate matched during polling but no request was found',
    )
  }
  return request
}

export async function waitForRequestLog<TRequest>(
  server: RequestLogServer<TRequest>,
  predicate: (requests: TRequest[]) => boolean,
  options: WaitForOptions = {},
): Promise<TRequest[]> {
  return waitFor(() => server.getRequestLog(), predicate, {
    ...options,
    description: options.description ?? 'mock server request log predicate',
    onTimeout:
      options.onTimeout ??
      (() =>
        requestLogSummary(server.getRequestLog(), server.getRequestCount())),
  })
}

function requestLogSummary<TRequest>(
  requests: TRequest[],
  requestCount: number,
): string {
  const summaries = requests.map((request, index) => {
    const req = request as {
      method?: string
      url?: string
      body?: { model?: string; messages?: unknown[] }
    }
    const url = req.url ? safeUrlPath(req.url) : '<unknown url>'
    const model = req.body?.model ? ` model=${req.body.model}` : ''
    const messages = Array.isArray(req.body?.messages)
      ? ` messages=${req.body.messages.length}`
      : ''
    return `  #${index}: ${req.method ?? '<unknown method>'} ${url}${model}${messages}`
  })

  return [`Request count: ${requestCount}`, ...summaries].join('\n')
}

function safeUrlPath(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname
  } catch {
    return url
  }
}
