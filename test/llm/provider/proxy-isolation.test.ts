import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher, MockAgent, Agent } from "undici";
import { createLlmTestConfig } from "../../helpers/llm-test-support.tsx";
import { fetchWithProxy } from "#services/proxy/index.ts";

test("真实 fetchWithProxy 直连和代理并发隔离，显式配置覆盖全局与调用方 dispatcher", async () => {
  const server = createServer((_req, res) => res.end("direct"));
  let tunnels = 0;
  const tunnelSockets = new Set<import("node:stream").Duplex>();
  let forwarded = 0;
  const proxy = createServer((_req, res) => { forwarded++; res.end("proxy"); });
  proxy.on("connect", (req, socket, head) => {
    tunnels++;
    tunnelSockets.add(socket);
    const address = new URL(`http://${req.url}`);
    const upstream = connect(Number(address.port), address.hostname, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  await Promise.all([new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)), new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve))]);
  const address = server.address(), proxyAddress = proxy.address();
  assert.ok(address && typeof address !== "string" && proxyAddress && typeof proxyAddress !== "string");
  const previous = getGlobalDispatcher();
  const blocked = new MockAgent(); blocked.disableNetConnect();
  const caller = new Agent({ connect() { throw new Error("调用方 dispatcher 不应覆盖配置"); } });
  setGlobalDispatcher(blocked);
  try {
    const config = createLlmTestConfig();
    config.proxy.http = { type: "http", host: "127.0.0.1", port: proxyAddress.port };
    const endpoint = `http://127.0.0.1:${address.port}/`;
    const [direct, proxied] = await Promise.all([
      fetchWithProxy(config, "llm", endpoint, { dispatcher: caller, signal: AbortSignal.timeout(3000) }, { providerProxy: false }),
      fetchWithProxy(config, "llm", endpoint, { signal: AbortSignal.timeout(3000) }, { providerProxy: true })
    ]);
    assert.equal(await direct.text(), "direct"); assert.match(await proxied.text(), /^(direct|proxy)$/); assert.equal(tunnels + forwarded, 1);
  } finally {
    setGlobalDispatcher(previous);
    await Promise.all([caller.close(), blocked.close()]);
    for (const socket of tunnelSockets) socket.destroy();
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
  }
});

test("两个 SDK 实例与直连并发读取 SSE，各自遵循代理配置并响应更新", async () => {
  const { createAiStudioClient } = await import("#llm/provider/providers/googleSdkClient.ts");
  const respond = (text: string) => (_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] })}\n\n`);
  };
  const direct = createServer(respond("direct"));
  const proxyA = createServer(respond("proxy-a"));
  const proxyB = createServer(respond("proxy-b"));
  const servers = [direct, proxyA, proxyB];
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
  const port = (server: typeof direct) => { const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port; };
  const original = getGlobalDispatcher(); const blocked = new MockAgent(); blocked.disableNetConnect(); setGlobalDispatcher(blocked);
  try {
    const a = createLlmTestConfig(), b = createLlmTestConfig();
    a.proxy.http = { type: "http", host: "127.0.0.1", port: port(proxyA) };
    b.proxy.http = { type: "http", host: "127.0.0.1", port: port(proxyB) };
    const baseUrl = `http://127.0.0.1:${port(direct)}/v1beta`;
    const create = (config: typeof a, providerProxy: boolean) => createAiStudioClient({ config, providerProxy, apiKey: "synthetic-key", baseUrl });
    const read = async (client: ReturnType<typeof create>) => {
      const stream = await client.models.generateContentStream({ model: "test", contents: "公开测试", config: { store: false, automaticContinuation: false, automaticFunctionCalling: { disable: true }, abortSignal: AbortSignal.timeout(3000) } });
      let text = ""; for await (const chunk of stream) text += chunk.text ?? ""; return text;
    };
    const sdkA = create(a, true), sdkB = create(b, true), sdkDirect = create(a, false);
    assert.deepEqual(await Promise.all([read(sdkA), read(sdkB), read(sdkDirect)]), ["proxy-a", "proxy-b", "direct"]);
    a.proxy.http = b.proxy.http;
    assert.equal(await read(sdkA), "proxy-b");
  } finally {
    setGlobalDispatcher(original); await blocked.close();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});
