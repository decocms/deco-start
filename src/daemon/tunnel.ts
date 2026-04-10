/**
 * Tunnel registration — connects local dev server to deco.cx admin
 * via a WebSocket reverse proxy (@deco-cx/warp-node).
 *
 * Ported from: deco-cx/deco daemon/tunnel.ts
 */
import { connect } from "@deco-cx/warp-node";

export interface TunnelOptions {
  /** Environment name (DECO_ENV_NAME). */
  env: string;
  /** Site name (DECO_SITE_NAME). */
  site: string;
  /** Local dev server port. */
  port: number;
  /** Use deco.host relay (true) or simpletunnel.deco.site (false). Default true. */
  decoHost?: boolean;
}

export interface TunnelConnection {
  close: () => void;
  domain: string;
}

const VERBOSE = process.env.VERBOSE;

export async function startTunnel(
  opts: TunnelOptions,
): Promise<TunnelConnection> {
  const { env, site, port, decoHost = true } = opts;

  const decoHostDomain = `${env}--${site}.deco.host`;
  const { server, domain } = decoHost
    ? { server: `wss://${decoHostDomain}`, domain: decoHostDomain }
    : {
        server: "wss://simpletunnel.deco.site",
        domain: `${env}--${site}.deco.site`,
      };

  const localAddr = `http://localhost:${port}`;
  const apiKey =
    process.env.DECO_TUNNEL_SERVER_TOKEN ??
    "c309424a-2dc4-46fe-bfc7-a7c10df59477";

  let closed = false;

  async function doConnect(): Promise<void> {
    if (closed) return;

    let r: Awaited<ReturnType<typeof connect>>;
    try {
      r = await connect({ domain, localAddr, server, apiKey });
    } catch (err) {
      if (closed) return;
      console.log(
        "[deco] tunnel connect failed, retrying in 500ms…",
        VERBOSE ? err : "",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      return doConnect();
    }

    r.registered
      .then(() => {
        const adminUrl = new URL(
          `/sites/${site}/spaces/dashboard?env=${env}`,
          "https://admin.deco.cx",
        );
        console.log(
          `\n[deco] tunnel connected — env \x1b[32m${env}\x1b[0m for site \x1b[34m${site}\x1b[0m` +
            `\n   -> Preview: \x1b[36mhttps://${domain}\x1b[0m` +
            `\n   -> Admin:   \x1b[36m${adminUrl.href}\x1b[0m\n`,
        );
      })
      .catch((err) => {
        console.error("[deco] tunnel registration failed:", err);
      });

    r.closed
      .then(async (reason) => {
        if (closed) return;
        if (
          reason &&
          typeof reason === "object" &&
          "intentional" in reason &&
          (reason as Record<string, unknown>).intentional
        )
          return;
        console.log(
          "[deco] tunnel disconnected, retrying in 500ms…",
          VERBOSE ? reason : "",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        return doConnect();
      })
      .catch(async (err: unknown) => {
        if (closed) return;
        if (
          err &&
          typeof err === "object" &&
          "intentional" in err &&
          (err as Record<string, unknown>).intentional
        )
          return;
        console.log(
          "[deco] tunnel error, retrying in 500ms…",
          VERBOSE ? err : "",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        return doConnect();
      });
  }

  await doConnect();

  return {
    close() {
      closed = true;
    },
    domain,
  };
}
