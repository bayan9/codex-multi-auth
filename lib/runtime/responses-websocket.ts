import { ClientCancellationError } from "../request/client-cancellation.js";
import type { Duplex } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { parseModelRoute } from "../model-route-policy.js";
import { isRecord } from "../utils.js";
import { ResponseOutputHistory, hasOrphanToolResult } from "./response-output-history.js";

const CONTEXT_HEADER = "x-local-responses-transport";
const terminal = new Set([
	"response.completed",
	"response.failed",
	"response.incomplete",
	"error",
]);
type Json = Record<string, unknown>;
type Chain = { body: Json; output: unknown[]; pool: string; bytes: number };
type Context = { signal: AbortSignal; session: SocketSession; previousId?: string; delta?: unknown };
function wireError(code: string, status = 400): Json {
	return {
		type: "error",
		status,
		error: {
			type: "invalid_request_error",
			code,
			message:
				code === "previous_response_not_found"
					? "Retry with complete input and no previous_response_id."
					: "The local WebSocket request could not be served.",
		},
	};
}
function bodyJson(body: RequestInit["body"]): Json {
	const value: unknown = JSON.parse(
		typeof body === "string"
			? body
			: Buffer.from(body as Uint8Array).toString("utf8"),
	);
	if (!isRecord(value)) throw Error("Invalid response body");
	return value;
}

/** Per-client memory only; credentials never leave the existing routing boundary. */
class SocketSession {
	readonly channels = new Map<string, WebSocket>();
	readonly owners = new Map<string, WebSocket>();
	readonly chains = new Map<string, Chain>();
	bytes = 0;
	controller: AbortController | undefined;
	closed = false;
	constructor(
		readonly maxBytes: number,
		readonly stats: {
			connections: number;
			upstreamConnections: number;
			upstreamRequests: number;
		},
	) {}
	close() {
		this.closed = true;
		this.controller?.abort();
		for (const socket of this.channels.values()) socket.terminate();
		this.channels.clear();
		this.owners.clear();
		this.chains.clear();
		this.bytes = 0;
	}
	remember(id: string, body: Json, output: unknown[], pool: string) {
		const bytes = Buffer.byteLength(JSON.stringify({ body, output }));
		if (bytes > this.maxBytes) return;
		const old = this.chains.get(id);
		if (old) this.bytes -= old.bytes;
		this.chains.delete(id);
		this.chains.set(id, { body, output, pool, bytes });
		this.bytes += bytes;
		while (this.bytes > this.maxBytes || this.chains.size > 32) {
			const first = this.chains.keys().next().value;
			if (!first) break;
			const entry = this.chains.get(first);
			this.bytes -= entry?.bytes ?? 0;
			this.chains.delete(first);
			this.owners.delete(first);
		}
	}
	async fetch(
		input: string | URL | Request,
		init: RequestInit,
		context: Context,
	): Promise<Response> {
        if (context.signal.aborted || this.closed) throw new ClientCancellationError();
		const url = new URL(String(input));
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const headers = new Headers(init.headers);
		const key = createHash("sha256")
			.update(url.toString())
			.update("\0")
			.update(headers.get("authorization") ?? "")
			.update("\0")
			.update(headers.get("chatgpt-account-id") ?? "")
			.digest("hex");
		const body = bodyJson(init.body);
		delete body.stream;
		delete body.background;
		body.store = false;
		body.type = "response.create";
		let socket = this.channels.get(key);
		if (socket?.readyState !== WebSocket.OPEN) {
			socket?.terminate();
			this.channels.delete(key);
			socket = undefined;
		}
		if (
			context.previousId &&
			socket &&
			this.owners.get(context.previousId) === socket
		) {
			body.previous_response_id = context.previousId;
			body.input = context.delta;
		}
		else if (context.previousId && hasOrphanToolResult(body.input)) {
			return Response.json(wireError("previous_response_not_found"), {status: 400});
		}
		if (!socket) {
			if (context.signal.aborted || this.closed) throw new ClientCancellationError();
			if (this.channels.size >= 16) {
				const first = this.channels.keys().next().value;
				if (first) {
					this.channels.get(first)?.terminate();
					this.channels.delete(first);
				}
			}
			for (const name of [
				"connection",
				"upgrade",
				"content-length",
				"content-type",
				"content-encoding",
				"host",
			])
				headers.delete(name);
			this.stats.upstreamConnections++;
			socket = new WebSocket(url, {
				headers: Object.fromEntries(headers),
				followRedirects: false,
				handshakeTimeout: 15000,
				maxPayload: this.maxBytes,
				perMessageDeflate: false,
			});
			const opening = socket;
			const rejected = await new Promise<Response | undefined>(
				(resolve, reject) => {
					const abort = () => {
						opening.terminate();
						cleanup();
                        reject(context.signal.aborted ? new ClientCancellationError() : Error("WebSocket request cancelled"));
					};
					const cleanup = () => {
                        init.signal?.removeEventListener("abort", abort);
                        context.signal.removeEventListener("abort", abort);
                    };
                    context.signal.addEventListener("abort", abort, {once:true});
					init.signal?.addEventListener("abort", abort, { once: true });
					opening.once("open", () => {
						cleanup();
						resolve(undefined);
					});
					opening.once("error", () => {
						cleanup();
						reject(context.signal.aborted ? new ClientCancellationError() : Error("Upstream WebSocket connection failed"));
					});
					opening.once("unexpected-response", (_request, response) => {
						cleanup();
						response.resume();
						const status = response.statusCode ?? 502;
						resolve(
							Response.json(
								{
									error: {
										code: "websocket_handshake_rejected",
										message: "Upstream rejected the WebSocket handshake.",
									},
								},
								{ status: status >= 400 && status <= 599 ? status : 502 },
							),
						);
						opening.terminate();
					});
				},
			);
			if (rejected) return rejected;
			this.channels.set(key, socket);
		}
		const active = socket;
		return new Promise<Response>((resolve, reject) => {
			let accepted = false,
				finished = false;
			let streamController: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						streamController = controller;
					},
					cancel() {
						active.terminate();
					},
				},
				{ highWaterMark: this.maxBytes, size: (chunk) => chunk.byteLength },
			);
			const cleanup = () => {
				active.off("message", onMessage);
				active.off("close", onClose);
				active.off("error", onClose);
				init.signal?.removeEventListener("abort", abort);
                context.signal.removeEventListener("abort", abort);
			};
			const onClose = () => {
				if (finished) return;
				finished = true;
				cleanup();
				this.channels.delete(key);
                const error = context.signal.aborted || this.closed
                    ? new ClientCancellationError()
                    : Error("Upstream WebSocket disconnected");
                if (accepted) streamController.error(error);
                else reject(error);
			};
			const abort = () => active.terminate();
			const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
				try {
					if (isBinary) throw Error("Unexpected binary response");
					const text = raw.toString();
					const event: unknown = JSON.parse(text);
					if (!isRecord(event) || typeof event.type !== "string")
						throw Error("Invalid response event");
					if (event.type === "error" && !accepted) {
						finished = true;
						cleanup();
						const status =
							typeof event.status === "number" &&
							event.status >= 400 &&
							event.status <= 599
								? event.status
								: 400;
						resolve(Response.json(event, { status }));
						return;
					}
					if (!accepted) {
						accepted = true;
						resolve(
							new Response(stream, {
								headers: { "content-type": "text/event-stream" },
							}),
						);
					}
					if ((streamController.desiredSize ?? 0) < -this.maxBytes)
						throw Error("Upstream buffer exceeded");
					streamController.enqueue(Buffer.from(`data: ${text}\n\n`));
					if (
						isRecord(event.response) &&
						typeof event.response.id === "string"
					) {
						this.owners.set(event.response.id, active);
						if (this.owners.size > 64) {
							const first = this.owners.keys().next().value;
							if (first) this.owners.delete(first);
						}
					}
					if (terminal.has(event.type)) {
						finished = true;
						cleanup();
						streamController.close();
					}
				} catch {
					active.terminate();
					onClose();
				}
			};
			active.on("message", onMessage);
			active.once("close", onClose);
			active.once("error", onClose);
			init.signal?.addEventListener("abort", abort, { once: true });
			context.signal.addEventListener("abort", abort, {once:true});
            if (init.signal?.aborted || context.signal.aborted) {
				abort();
				return;
			}
			this.stats.upstreamRequests++;
			active.send(JSON.stringify(body), (error) => {
				if (error) onClose();
			});
		});
	}
}

/** Adapts only the transport; authenticated HTTP routing remains the policy authority. */
export class ResponsesWebSocketGateway {
	readonly stats = {
		connections: 0,
		upstreamConnections: 0,
		upstreamRequests: 0,
	};
	private readonly contexts = new Map<string, Context>();
	private readonly scope = new AsyncLocalStorage<Context>();
	private readonly sessions = new Set<SocketSession>();
	private readonly wss: WebSocketServer;
	private readonly maxBytes: number;
	constructor(
		private readonly upstreamFetch: typeof fetch,
		private readonly options: {
			maxPayloadBytes: number;
			upgrade?: (
				req: IncomingMessage,
				socket: Duplex,
				head: Buffer,
			) => Promise<boolean>;
			routeModel?: (model: string, headers: Headers) => string;
		},
	) {
		this.maxBytes = options.maxPayloadBytes;
		this.wss = new WebSocketServer({
			noServer: true,
			maxPayload: this.maxBytes,
			perMessageDeflate: false,
		});
	}
	readonly fetch: typeof fetch = async (input, init) => {
		const context = this.scope.getStore();
		if (
			context &&
			init?.method === "POST" &&
			new URL(String(input)).pathname.endsWith("/responses")
		)
			return context.session.fetch(input, init, context);
		return this.upstreamFetch(input, init);
	};
	handle(req: IncomingMessage, handler: () => Promise<void>): void {
		const id = req.headers[CONTEXT_HEADER];
		delete req.headers[CONTEXT_HEADER];
		const context = typeof id === "string" ? this.contexts.get(id) : undefined;
		if (typeof id === "string") this.contexts.delete(id);
		if (context)
			this.scope.run(context, () => {
				void handler();
			});
		else void handler();
	}
	attach(server: Server, baseUrl: string): void {
		server.on("upgrade", (req, socket, head) => {
            // Node relinquishes its socket error handler before emitting upgrade.
            socket.on("error", () => socket.destroy());
			const reject = (status: number) => {
                if (socket.destroyed) return;
				socket.end(
					`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
				);
			};
			void (async () => {
				const authorization = req.headers.authorization ?? "";
				// An authenticated unknown HTTP path returns 404; all unknown credentials return 401.
				const auth = await fetch(`${baseUrl}/__websocket_auth_check__`, {
					headers: { authorization },
					signal: AbortSignal.timeout(5000),
				});
				await auth.body?.cancel();
				if (auth.status !== 404) {
					reject(401);
					return;
				}
				if (req.headers.origin) {
					reject(403);
					return;
				}
				if (await this.options.upgrade?.(req, socket, head)) return;
				const path = new URL(req.url ?? "/", baseUrl).pathname;
				if (
					![
						"/responses",
						"/v1/responses",
						"/backend-api/codex/responses",
					].includes(path)
				) {
					reject(404);
					return;
				}
				if (req.headers.origin || this.sessions.size >= 64) {
					reject(403);
					return;
				}
                if (socket.destroyed) return;
				this.wss.handleUpgrade(req, socket, head, (ws) =>
					this.serve(ws, req, baseUrl),
				);
			})().catch(() => reject(503));
		});
	}
	private serve(ws: WebSocket, req: IncomingMessage, baseUrl: string): void {
		this.stats.connections++;
		const session = new SocketSession(this.maxBytes, this.stats);
		this.sessions.add(session);
		let queue = Promise.resolve(),
			queued = 0,
			queuedBytes = 0;
		const send = (event: Json) => {
			if (ws.readyState !== WebSocket.OPEN) return;
			if (ws.bufferedAmount > this.maxBytes) {
				ws.terminate();
				return;
			}
			ws.send(JSON.stringify(event));
		};
		ws.on("error", () => ws.terminate());
		ws.once("close", () => {
			session.close();
			this.sessions.delete(session);
		});
		ws.on("message", (raw, isBinary) => {
			let event: Json;
			try {
				const parsed: unknown = JSON.parse(raw.toString());
				if (isBinary || !isRecord(parsed)) throw Error();
				event = parsed;
			} catch {
				send(wireError("invalid_websocket_event"));
				return;
			}
			if (event.type === "response.cancel") {
				session.controller?.abort();
				for (const channel of session.channels.values()) channel.terminate();
				return;
			}
			if (event.type !== "response.create") {
				send(wireError("unsupported_websocket_event"));
				return;
			}
			const eventBytes = Buffer.byteLength(raw.toString());
			if (++queued > 16 || queuedBytes + eventBytes > this.maxBytes) {
				queued--;
				send(wireError("websocket_queue_full", 429));
				return;
			}
			queuedBytes += eventBytes;
			queue = queue
				.then(async () => {
					if (session.closed) return;
					try {
						if (typeof event.model !== "string" || !Array.isArray(event.input))
							throw Error("invalid_request_body");
						const routingHeaders = new Headers();
						for (const [key, value] of Object.entries(req.headers))
							if (typeof value === "string") routingHeaders.set(key, value);
						event.model =
							this.options.routeModel?.(event.model, routingHeaders) ??
							event.model;
						const pool = parseModelRoute(event.model as string).kind;
						const previousId =
							typeof event.previous_response_id === "string"
								? event.previous_response_id
								: undefined;
						const prior = previousId
							? session.chains.get(previousId)
							: undefined;
						if (previousId && !prior) {
							send(wireError("previous_response_not_found"));
							return;
						}
						if (prior && prior.pool !== pool) {
							send(wireError("model_route_pool_mismatch"));
							return;
						}
						const body: Json = {
							...prior?.body,
							...event,
							input: prior
								? [
										...(Array.isArray(prior.body.input)
											? prior.body.input
											: []),
										...prior.output,
										...event.input,
									]
								: event.input,
							stream: true,
							store: false,
						};
						delete body.type;
						delete body.previous_response_id;
						// Native prewarm sets generate=false; omission on the next create
						// means generate normally, not inherit the warm-up's control flag.
						if (event.generate === undefined) delete body.generate;
						if (Buffer.byteLength(JSON.stringify(body)) > this.maxBytes) {
							send(wireError("websocket_context_too_large", 413));
							return;
						}
						const id = randomUUID();
						const controller = new AbortController();
                        session.controller = controller;
                        this.contexts.set(id, { session, previousId, delta: event.input, signal: controller.signal });
						const headers = new Headers();
						for (const [key, value] of Object.entries(req.headers)) {
							if (
								typeof value === "string" &&
								!/^(host|connection|upgrade|sec-websocket-|content-|origin)/i.test(
									key,
								)
							)
								headers.set(key, value);
						}
						headers.set(CONTEXT_HEADER, id);
						headers.set("content-type", "application/json");
						try {
							const response = await fetch(`${baseUrl}/responses`, {
								method: "POST",
								headers,
								body: JSON.stringify(body),
								signal: controller.signal,
							});
							if (!response.ok) {
								const data: unknown = await response.json();
								send(
									isRecord(data)
										? { ...data, type: "error", status: response.status }
										: wireError("websocket_request_failed", response.status),
								);
								return;
							}
							if (!response.body) throw Error("missing_response_body");
							let buffer = "";
							const outputHistory = new ResponseOutputHistory(this.maxBytes);
							const decoder = new TextDecoder();
							for await (const chunk of response.body) {
								buffer += decoder.decode(chunk, { stream: true });
								if (Buffer.byteLength(buffer) > this.maxBytes)
									throw Error("websocket_event_too_large");
								let index: number;
								while ((index = buffer.indexOf("\n\n")) >= 0) {
									const frame = buffer.slice(0, index);
									buffer = buffer.slice(index + 2);
									const data = frame
										.split("\n")
										.filter((line) => line.startsWith("data:"))
										.map((line) => line.slice(5).trimStart())
										.join("\n");
									if (!data || data === "[DONE]") continue;
									const parsed: unknown = JSON.parse(data);
									if (!isRecord(parsed)) throw Error("invalid_response_event");
									outputHistory.observe(parsed);
									if (
										parsed.type === "response.completed" &&
										isRecord(parsed.response) &&
										typeof parsed.response.id === "string"
									) {
										const output = outputHistory.finish(parsed.response.output);
										if (output) session.remember(
											parsed.response.id,
											body,
											output,
											pool,
										);
									}
									send(parsed);
								}
							}
						} finally {
							this.contexts.delete(id);
							if (session.controller === controller)
								session.controller = undefined;
						}
					} catch {
						if (!session.closed)
							send(wireError("websocket_request_failed", 502));
					}
				})
				.finally(() => {
					queued--;
					queuedBytes -= eventBytes;
				});
		});
	}
	close() {
		for (const ws of this.wss.clients) ws.terminate();
		for (const session of this.sessions) session.close();
		this.contexts.clear();
		this.wss.close();
	}
}
