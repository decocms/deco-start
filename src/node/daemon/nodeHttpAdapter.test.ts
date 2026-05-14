import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeMiddleware } from "./nodeHttpAdapter";

describe("toNodeMiddleware", () => {
  let httpServer: ReturnType<typeof createServer>;
  let url: string;
  let nextWasCalled = false;

  beforeEach(async () => {
    nextWasCalled = false;
    const handler = toNodeMiddleware(async (req: Request) => {
      const u = new URL(req.url);
      if (u.pathname === "/fall") {
        // Returning null signals fall-through.
        return null;
      }
      if (u.pathname === "/echo-body" && req.method === "POST") {
        const body = await req.text();
        return new Response(`echo:${body}`, { status: 201 });
      }
      return new Response("hello", {
        status: 200,
        headers: { "X-Foo": "bar" },
      });
    });

    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      handler(req, res, () => {
        nextWasCalled = true;
        res.statusCode = 418;
        res.end();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const addr = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

  it("translates a Web Response to a Node ServerResponse", async () => {
    const r = await fetch(url + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Foo")).toBe("bar");
    expect(await r.text()).toBe("hello");
  });

  it("forwards request bodies", async () => {
    const r = await fetch(url + "/echo-body", { method: "POST", body: "ping" });
    expect(r.status).toBe(201);
    expect(await r.text()).toBe("echo:ping");
  });

  it("calls next() when the handler returns null", async () => {
    const r = await fetch(url + "/fall");
    expect(r.status).toBe(418);
    expect(nextWasCalled).toBe(true);
  });
});
