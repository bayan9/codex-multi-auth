import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { ResponsesWebSocketGateway } from "../lib/runtime/responses-websocket.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("listen failed");
	return `http://127.0.0.1:${address.port}`;
}
async function fixture(respond?: (ws: WebSocket, body: Record<string, unknown>, id: string) => boolean) {
	const upstream = createServer();
	const wss = new WebSocketServer({ server: upstream });
	const calls: Record<string, unknown>[] = [];
	let connections = 0;
	let upstreamCredential = "fixture-upstream";
	wss.on("connection", (ws) => {
		connections++;
		ws.on("message", (data) => {
			const body = JSON.parse(data.toString());
			calls.push(body);
			const id = `resp_${calls.length}`;
			if (body.model === "rejected") {
				ws.send(
					JSON.stringify({
						type: "error",
						status: 400,
						error: {
							code: "model_not_found",
							param: "model",
							message: "Unsupported model",
						},
					}),
				);
				return;
			}
			ws.send(JSON.stringify({ type: "response.created", response: { id } }));
			if (respond?.(ws, body, id)) return;
			if (body.model === "disconnect") {
				ws.close();
				return;
			}
			if (body.model === "stall") return;
			ws.send(
				JSON.stringify({
					type: "response.completed",
					response: {
						id,
						output: body.generate === false ? [] : [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "OK" }],
							},
						],
					},
				}),
			);
		});
	});
	const upstreamUrl = await listen(upstream);
	cleanups.push(async () => {
		for (const ws of wss.clients) ws.terminate();
		wss.close();
		await new Promise<void>((r) => upstream.close(() => r()));
	});
	const gateway = new ResponsesWebSocketGateway(fetch, {
		maxPayloadBytes: 16384,
	});
	const server = createServer((req, res) => {
		gateway.handle(req, async () => {
			if (req.headers.authorization !== "Bearer fixture-local") {
				res.writeHead(401);
				res.end();
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(404);
				res.end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const response = await gateway.fetch(`${upstreamUrl}/responses`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstreamCredential}`,
					"content-type": "application/json",
				},
				body: Buffer.concat(chunks),
			});
			res.writeHead(response.status, Object.fromEntries(response.headers));
			try {
				if (response.body)
					for await (const chunk of response.body) res.write(chunk);
				res.end();
			} catch {
				res.destroy();
			}
		});
	});
	const baseUrl = await listen(server);
	gateway.attach(server, baseUrl);
	cleanups.push(async () => {
		gateway.close();
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	});
	const connect = async (token = "fixture-local") => {
		const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/responses", {
			headers: { authorization: `Bearer ${token}` },
		});
		await once(ws, "open");
		cleanups.push(async () => ws.terminate());
		return ws;
	};
	return { disconnectUpstream: async () => { await Promise.all([...wss.clients].map(async socket => { const closed=once(socket,"close");socket.terminate();await closed; })); await new Promise(resolve=>setImmediate(resolve)); }, connect, calls, connections: () => connections, baseUrl, useCredential: (credential: string) => { upstreamCredential = credential; } };
}
function turn(
	ws: WebSocket,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const events: Record<string, unknown>[] = [];
		const timer = setTimeout(() => {
			ws.off("message", onMessage);
			reject(Error("turn timeout"));
		}, 3000);
		const onMessage = (raw: WebSocket.RawData) => {
			const event = JSON.parse(raw.toString());
			events.push(event);
			if (
				["response.completed", "response.failed", "error"].includes(event.type)
			) {
				clearTimeout(timer);
				ws.off("message", onMessage);
				resolve(events);
			}
		};
		ws.on("message", onMessage);
		ws.send(JSON.stringify({ type: "response.create", ...body }));
	});
}
it("uses real upstream WebSockets and reuses the socket for a continuation", async () => {
	const f = await fixture();
	const ws = await f.connect();
	await turn(ws, {
		model: "shared",
		input: [{ role: "user", content: "hello" }],
	});
	await turn(ws, {
		model: "shared",
		previous_response_id: "resp_1",
		input: [{ role: "user", content: "again" }],
	});
	expect(f.connections()).toBe(1);
	expect(f.calls[1]).toMatchObject({
		type: "response.create",
		previous_response_id: "resp_1",
		input: [{ role: "user", content: "again" }],
		store: false,
	});
	expect(f.calls[0]).not.toHaveProperty("stream");
});
it("rejects unknown or cross-pool continuations without sending them upstream", async () => {
	const f = await fixture();
	const ws = await f.connect();
	expect(
		(
			await turn(ws, {
				model: "zdr/shared",
				previous_response_id: "unknown",
				input: [],
			})
		)[0],
	).toMatchObject({
		type: "error",
		error: { code: "previous_response_not_found" },
	});
	await turn(ws, { model: "zdr/shared", input: [] });
	expect(
		(
			await turn(ws, {
				model: "shared",
				previous_response_id: "resp_1",
				input: [],
			})
		)[0],
	).toMatchObject({
		type: "error",
		error: { code: "model_route_pool_mismatch" },
	});
	expect(f.calls).toHaveLength(1);
});
it("does not open an upstream connection for an unauthorized handshake", async () => {
	const f = await fixture();
	await expect(f.connect("wrong")).rejects.toThrow();
	expect(f.connections()).toBe(0);
});
it("passes a pre-generation rejection through the routing pipeline as an HTTP failure", async () => {
	const f = await fixture();
	const ws = await f.connect();
	expect((await turn(ws, { model: "rejected", input: [] }))[0]).toMatchObject({
		type: "error",
		status: 400,
		error: { code: "model_not_found" },
	});
	expect(f.calls).toHaveLength(1);
});
it("fails explicitly for unsupported control events", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const event = once(ws, "message");
	ws.send(JSON.stringify({ type: "unknown.control" }));
	expect(JSON.parse((await event)[0].toString())).toMatchObject({
		type: "error",
		error: { code: "unsupported_websocket_event" },
	});
	expect(f.calls).toHaveLength(0);
});

it("does not replay after generation starts and the upstream disconnects", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const events = await turn(ws, { model: "disconnect", input: [] });
	expect(events[0]?.type).toBe("response.created");
	expect(events.at(-1)?.type).toBe("error");
	expect(f.calls).toHaveLength(1);
});
it("cancels active generation and can start another request", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const event = once(ws, "message");
	const first = turn(ws, { model: "stall", input: [] });
	await event;
	ws.send(JSON.stringify({ type: "response.cancel" }));
	expect((await first).at(-1)?.type).toBe("error");
	expect((await turn(ws, { model: "shared", input: [] })).at(-1)?.type).toBe(
		"response.completed",
	);
	expect(f.calls).toHaveLength(2);
});
it("rejects oversized frames before any upstream request", async () => {
	const f = await fixture();
	const ws = await f.connect();
	const closed = once(ws, "close");
	ws.send(
		JSON.stringify({
			type: "response.create",
			model: "shared",
			input: [{ role: "user", content: "x".repeat(20000) }],
		}),
	);
	await closed;
	expect(f.calls).toHaveLength(0);
});
it("never shares continuation IDs between client connections", async () => {
	const f = await fixture();
	await turn(await f.connect(), { model: "shared", input: [] });
	const second = await f.connect();
	expect(
		(
			await turn(second, {
				model: "shared",
				previous_response_id: "resp_1",
				input: [],
			})
		)[0],
	).toMatchObject({ error: { code: "previous_response_not_found" } });
	expect(f.calls).toHaveLength(1);
});


it("does not inherit generate false from native prewarm into subsequent turns", async () => {
 const f = await fixture();
 const ws = await f.connect();
 const warmup = await turn(ws, {model:"shared", generate:false, input:[{role:"user",content:"hello"}]});
 expect(warmup.at(-1)?.response).toMatchObject({output:[]});
 const response = await turn(ws, {model:"shared", previous_response_id:"resp_1", input:[]});
 expect(f.calls[0]?.generate).toBe(false);
 expect(f.calls[1]).not.toHaveProperty("generate");
 expect(response.at(-1)?.response).toMatchObject({output:[{type:"message"}]});
 await turn(ws, {model:"shared", previous_response_id:"resp_2", input:[{role:"user",content:"again"}]});
 expect(f.calls[2]).not.toHaveProperty("generate");
 const secondWarmup = await turn(ws, {model:"shared", previous_response_id:"resp_3", generate:false, input:[]});
 expect(f.calls[3]?.generate).toBe(false);
 expect(secondWarmup.at(-1)?.response).toMatchObject({output:[]});
});

const toolCall={type:"custom_tool_call",id:"item-tool",call_id:"call-fixture",name:"fixture_tool",input:"fixture input"};
const toolResult={type:"custom_tool_call_output",call_id:"call-fixture",output:"fixture result"};
it.each([{output:undefined}, {output:[]}, {output:[toolCall]}])("replays streamed tool calls after rotation when terminal output is $output",async ({output:terminalOutput})=>{
 const f=await fixture((ws,body,id)=>{
  if(id!=="resp_1")return false;
  const reasoning={type:"reasoning",id:"item-reasoning",summary:[],encrypted_content:"fixture-encrypted"};
  // Completion order differs from output order. Added items are unfinished.
  for(const [index,item] of [[0,reasoning],[1,{...toolCall,input:""}]] as const)
   ws.send(JSON.stringify({type:"response.output_item.added",output_index:index,item}));
  for(const [index,item] of [[1,toolCall],[0,reasoning]] as const)
   ws.send(JSON.stringify({type:"response.output_item.done",output_index:index,item}));
  ws.send(JSON.stringify({type:"response.completed",response:{id,...(terminalOutput===undefined?{}:{output:terminalOutput})}}));
  return true;
 });
 const ws=await f.connect();
 const initial=[{role:"user",content:"Use the fixture tool"}];
 await turn(ws,{model:"shared",input:initial});
 f.useCredential("another-account");
 await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[toolResult]});
 expect(f.connections()).toBe(2);
 expect(f.calls[1]).not.toHaveProperty("previous_response_id");
 expect(f.calls[1]?.input).toEqual([...initial,expect.objectContaining({type:"reasoning",encrypted_content:"fixture-encrypted"}),toolCall,toolResult]);
});

it("refuses to cache unfinished tool history and requests full context",async()=>{
 const f=await fixture((ws,_body,id)=>{
  ws.send(JSON.stringify({type:"response.output_item.added",output_index:0,item:{...toolCall,input:""}}));
  ws.send(JSON.stringify({type:"response.completed",response:{id}}));
  return true;
 });
 const ws=await f.connect();
 await turn(ws,{model:"shared",input:[]});
 f.useCredential("another-account");
 const events=await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[toolResult]});
 expect(events.at(-1)).toMatchObject({type:"error",error:{code:"previous_response_not_found"}});
 expect(f.calls).toHaveLength(1);
});

it("does not send orphan tool results upstream during cross-account replay",async()=>{
 const f=await fixture();const ws=await f.connect();
 await turn(ws,{model:"shared",input:[]});
 f.useCredential("another-account");
 const events=await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[toolResult]});
 expect(events.at(-1)).toMatchObject({type:"error",error:{code:"previous_response_not_found"}});
 expect(f.calls).toHaveLength(1);
});

it("does not reuse a previous response ID on a replacement socket with the same credentials",async()=>{
 const f=await fixture(); const ws=await f.connect();
 await turn(ws,{model:"shared",input:[{role:"user",content:"first"}]});
 await f.disconnectUpstream();
 await turn(ws,{model:"shared",input:[{role:"user",content:"new root"}]});
 await turn(ws,{model:"shared",previous_response_id:"resp_1",input:[{role:"user",content:"old branch"}]});
 expect(f.connections()).toBe(2);
 expect(f.calls[2]).not.toHaveProperty("previous_response_id");
 expect(f.calls[2]?.input).toEqual([{role:"user",content:"first"},expect.objectContaining({type:"message"}),{role:"user",content:"old branch"}]);
});
