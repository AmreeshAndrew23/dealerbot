// Thin client for the WhatsApp Cloud API (Meta Graph API). No retries here: callers decide,
// using GraphApiError.retryable.
import type { OutboundPayload } from "@fmcg/contracts";

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number | undefined,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
  /** Rate limits, server errors and network failures can be retried; 4xx request errors cannot. */
  get retryable(): boolean {
    return this.httpStatus === 0 || this.httpStatus === 429 || this.httpStatus >= 500 || this.code === 130429 || this.code === 131016;
  }
}

export interface GraphClientOptions {
  accessToken: string;
  apiVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GraphClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly o: GraphClientOptions) {
    this.base = `${o.baseUrl ?? "https://graph.facebook.com"}/${o.apiVersion}`;
    this.f = o.fetchImpl ?? fetch;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.o.accessToken}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new GraphApiError(`Network error calling Graph API: ${(err as Error).message}`, 0, undefined, null);
    }
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new GraphApiError(e.message ?? `Graph API HTTP ${res.status}`, res.status, e.code, {
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        fbtrace_id: e.fbtrace_id,
        details: e.error_data?.details,
      });
    }
    return json as T;
  }

  /** Sends a message; returns the provider message ID (wamid). */
  async sendMessage(phoneNumberId: string, toE164: string, payload: OutboundPayload): Promise<string> {
    const to = toE164.replace(/^\+/, "");
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
    let body: Record<string, unknown>;
    switch (payload.kind) {
      case "text":
        body = { ...base, type: "text", text: { preview_url: false, body: payload.text } };
        break;
      case "buttons":
        body = {
          ...base,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: payload.body },
            action: { buttons: payload.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
          },
        };
        break;
      case "template":
        body = {
          ...base,
          type: "template",
          template: {
            name: payload.name,
            language: { code: payload.language },
            components: payload.body_params.length
              ? [{ type: "body", parameters: payload.body_params.map((t) => ({ type: "text", text: t })) }]
              : undefined,
          },
        };
        break;
    }
    const res = await this.call<{ messages?: Array<{ id: string }> }>("POST", `${phoneNumberId}/messages`, body);
    const id = res.messages?.[0]?.id;
    if (!id) throw new GraphApiError("Graph API accepted the request but returned no message id", 200, undefined, res);
    return id;
  }

  async markRead(phoneNumberId: string, providerMessageId: string): Promise<void> {
    await this.call("POST", `${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: providerMessageId,
    });
  }

  async getMediaInfo(mediaId: string): Promise<{ url: string; mime_type: string; sha256?: string; file_size?: number }> {
    return this.call("GET", encodeURIComponent(mediaId));
  }

  /** Downloads media bytes; the URL requires the same bearer token and expires after a few minutes. */
  async downloadMedia(url: string, maxBytes: number): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.f(url, {
        headers: { Authorization: `Bearer ${this.o.accessToken}` },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new GraphApiError(`Network error downloading media: ${(err as Error).message}`, 0, undefined, null);
    }
    if (!res.ok) throw new GraphApiError(`Media download HTTP ${res.status}`, res.status, undefined, null);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new MediaTooLargeError(declared);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new MediaTooLargeError(buf.length);
    return buf;
  }
}

export class MediaTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`Media is ${size} bytes, above the configured limit`);
  }
}
