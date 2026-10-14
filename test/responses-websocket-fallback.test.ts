import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { ResponsesWebSocketGateway } from "../lib/runtime/responses-websocket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Missing fixture address");
	return `http://127.0.0.1:${address.port}`;
}

function credential(headers: IncomingHttpHeaders): string | undefined {
	return headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
		?? (typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : undefined);
}

async function fixture() {
	let websocketCreates = 0;
	let httpCreates = 0;
	const upstream = createServer((_req, res) => {
		httpCreates++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_http", output: [] } })}\n\n`);
	});
	const wss = new WebSocketServer({ server: upstream });
	wss.on("connection", ws => ws.on("message", raw => {
		websocketCreates++;
		const body = JSON.parse(raw.toString());
		if (body.model.startsWith("rejected-")) {
			ws.send(JSON.stringify({ type: "error", status: Number(body.model.slice(9)), error: { code: "fixture_rejection" } }));
			return;
		}
		if (body.model !== "before-first-event") {
			ws.send(JSON.stringify({ type: "codex.rate_limits" }));
			ws.send(JSON.stringify({ type: "codex.response.metadata" }));
		}
		if (body.model !== "stall") ws.close(1011);
	}));
	const upstreamUrl = await listen(upstream);
	cleanups.push(async () => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
		upstream.closeAllConnections();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	});
	const gateway = new ResponsesWebSocketGateway(fetch, { maxPayloadBytes: 16384 });
	const server = createServer((req, res) => gateway.handle(req, async () => {
		if (!["fixture-a", "fixture-b"].includes(credential(req.headers) ?? "")) {
			res.writeHead(401).end();
			return;
		}
		if (req.method !== "POST" || req.url !== "/responses") {
			res.writeHead(404).end();
			return;
		}
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const response = await gateway.fetch(`${upstreamUrl}/responses`, {
				method: "POST",
				headers: { authorization: "Bearer fixture-upstream", "chatgpt-account-id": "fixture-workspace", "content-type": "application/json" },
				body: Buffer.concat(chunks),
			});
			res.writeHead(response.status, Object.fromEntries(response.headers));
			if (response.body) for await (const chunk of response.body) res.write(chunk);
			res.end();
		} catch {
			res.destroy();
		}
	}));
	const baseUrl = await listen(server);
	gateway.attach(server, baseUrl);
	cleanups.push(async () => {
		gateway.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	async function connect(headers: Record<string, string>, path = "/responses") {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + path, { headers });
		cleanups.push(async () => ws.terminate());
		const status = await new Promise<number>((resolve, reject) => {
			ws.once("open", () => resolve(101));
			ws.once("unexpected-response", (_req, res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
				ws.terminate();
			});
			ws.on("error", reject);
		});
		return { ws, status };
	}
	return { connect, baseUrl, stats: gateway.stats, counts: () => ({ websocketCreates, httpCreates }) };
}

const scope = { authorization: "Bearer fixture-a", session_id: "fixture-session", conversation_id: "fixture-thread" };

function request(ws: WebSocket, model = "disconnect"): Promise<void> {
	const done = new Promise<void>(resolve => {
		const onMessage = (raw: WebSocket.RawData) => {
			if (JSON.parse(raw.toString()).type !== "error") return;
			ws.off("message", onMessage);
			resolve();
		};
		ws.on("message", onMessage);
	});
	ws.send(JSON.stringify({ type: "response.create", model, input: [] }));
	return done;
}

async function disconnect(g: Awaited<ReturnType<typeof fixture>>, headers = scope, model = "disconnect") {
	const { ws, status } = await g.connect(headers);
	expect(status).toBe(101);
	await request(ws, model);
	const closed = once(ws, "close");
	ws.terminate();
	await closed;
}

it.each(["before-first-event", "disconnect"])("requests immediate native HTTP fallback after %s without replay", async model => {
	const g = await fixture();
	await disconnect(g, scope, model);
	expect((await g.connect(scope)).status).toBe(426);
	expect(g.counts()).toEqual({ websocketCreates: 1, httpCreates: 0 });
	const response = await fetch(`${g.baseUrl}/responses`, {
		method: "POST", headers: { ...scope, "content-type": "application/json" },
		body: JSON.stringify({ model: "fixture", input: [], stream: true }),
	});
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("response.completed");
	expect(g.counts()).toEqual({ websocketCreates: 1, httpCreates: 1 });
});

it("isolates fallback by authenticated client and thread, including shared session IDs", async () => {
	const g = await fixture();
	await disconnect(g);
	expect((await g.connect({ ...scope, conversation_id: "other-thread" })).status).toBe(101);
	expect((await g.connect({ ...scope, authorization: "Bearer fixture-b" })).status).toBe(101);
	expect((await g.connect(scope)).status).toBe(426);
});

it("normalizes bearer and API-key client authentication for the same session", async () => {
	const g = await fixture();
	await disconnect(g, { authorization: "bearer   fixture-a", session_id: "fixture-session", conversation_id: "fixture-thread" });
	expect((await g.connect({ "x-api-key": "fixture-a", session_id: "fixture-session", conversation_id: "fixture-thread" })).status).toBe(426);
});

it.each(["thread-id", "session-id", "session_id", "conversation_id"])("supports a native scope containing only %s", async header => {
	const g = await fixture();
	const headers = { authorization: "Bearer fixture-a", [header]: "fixture-scope" };
	await disconnect(g, headers);
	expect((await g.connect(headers)).status).toBe(426);
});

it("prefers native thread-id over conflicting legacy conversation and session aliases", async () => {
	const g = await fixture();
	const headers = { ...scope, "thread-id": "native-thread", "session-id": "native-session" };
	await disconnect(g, headers);
	expect((await g.connect({ ...headers, "thread-id": "sibling-thread" })).status).toBe(101);
	expect((await g.connect({ ...headers, conversation_id: "different-legacy-thread", "session-id": "different-session", session_id: "different-legacy-session" })).status).toBe(426);
});

it("prefers a legacy conversation over shared session aliases when native thread-id is absent", async () => {
	const g = await fixture();
	const headers = { ...scope, "session-id": "native-session" };
	await disconnect(g, headers);
	expect((await g.connect({ ...headers, conversation_id: "sibling-thread" })).status).toBe(101);
	expect((await g.connect({ ...headers, "session-id": "different-session" })).status).toBe(426);
});

it("prefers native session-id over conflicting legacy session_id when no thread is provided", async () => {
	const g = await fixture();
	const headers = { authorization: "Bearer fixture-a", "session-id": "native-session", session_id: "legacy-session" };
	await disconnect(g, headers);
	expect((await g.connect({ ...headers, "session-id": "other-native-session" })).status).toBe(101);
	expect((await g.connect({ ...headers, session_id: "other-legacy-session" })).status).toBe(426);
});

it("does not use a global cooldown when the client has no stable scope", async () => {
	const g = await fixture();
	const headers = { authorization: "Bearer fixture-a" };
	await disconnect(g, headers);
	expect((await g.connect(headers)).status).toBe(101);
	expect((await g.connect(scope)).status).toBe(101);
});

it("checks authentication, origin, and path before applying fallback", async () => {
	const g = await fixture();
	await disconnect(g);
	expect((await g.connect({ ...scope, authorization: "Bearer invalid" })).status).toBe(401);
	expect((await g.connect({ ...scope, origin: "https://example.com" })).status).toBe(403);
	expect((await g.connect(scope, "/unknown")).status).toBe(404);
	expect((await g.connect(scope)).status).toBe(426);
});

it("expires fallback after a short cooldown so a recovered transport can be retried", async () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
	const g = await fixture();
	await disconnect(g);
	expect((await g.connect(scope)).status).toBe(426);
	now.mockReturnValue(160_001);
	expect((await g.connect(scope)).status).toBe(101);
});

it("bounds the number of retained fallback scopes", async () => {
	const g = await fixture();
	for (let i = 0; i <= 256; i++) {
		await disconnect(g, { ...scope, conversation_id: `fixture-thread-${i}` });
	}
	expect((await g.connect({ ...scope, conversation_id: "fixture-thread-0" })).status).toBe(101);
	expect((await g.connect({ ...scope, conversation_id: "fixture-thread-256" })).status).toBe(426);
	expect(g.counts()).toEqual({ websocketCreates: 257, httpCreates: 0 });
}, 15_000);

it.each([401, 403, 429])("does not downgrade after an explicit upstream %s error", async status => {
	const g = await fixture();
	await disconnect(g, scope, `rejected-${status}`);
	expect((await g.connect(scope)).status).toBe(101);
});

it("does not downgrade after client cancellation", async () => {
	const g = await fixture();
	const { ws } = await g.connect(scope);
	const firstEvent = once(ws, "message");
	const done = request(ws, "stall");
	await firstEvent;
	ws.send(JSON.stringify({ type: "response.cancel" }));
	await done;
	expect(g.stats.lastDisconnect).toBeUndefined();
	expect((await g.connect(scope)).status).toBe(101);
	expect(g.counts()).toEqual({ websocketCreates: 1, httpCreates: 0 });
});
