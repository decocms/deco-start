/**
 * Minimal Cloudflare KV REST API client for CI.
 *
 * CI has no Worker KV binding, so the fast-deploy sync/migrate scripts write to
 * KV over the REST API instead. Only the two operations the scripts need —
 * single-key GET and PUT — are implemented.
 *
 * Auth/config via env (read by the scripts, passed to `createKvRestClient`):
 *   - CF_ACCOUNT_ID       Cloudflare account id
 *   - CF_KV_NAMESPACE_ID  target KV namespace id
 *   - CF_API_TOKEN        API token with "Workers KV Storage:Edit"
 *
 * `fetch` is injectable so the client is unit-testable without network.
 */

export interface KvRestConfig {
  accountId: string;
  namespaceId: string;
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override API base (tests). Defaults to the Cloudflare API. */
  baseUrl?: string;
}

export interface KvRestClient {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

/** Resolve the three required env vars or throw a clear error. */
export function kvConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<KvRestConfig, "fetchImpl" | "baseUrl"> {
  const accountId = env.CF_ACCOUNT_ID;
  const namespaceId = env.CF_KV_NAMESPACE_ID;
  const token = env.CF_API_TOKEN;
  const missing = [
    !accountId && "CF_ACCOUNT_ID",
    !namespaceId && "CF_KV_NAMESPACE_ID",
    !token && "CF_API_TOKEN",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`missing required env var(s): ${missing.join(", ")}`);
  }
  return { accountId: accountId!, namespaceId: namespaceId!, token: token! };
}

export function createKvRestClient(config: KvRestConfig): KvRestClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = config.baseUrl ?? DEFAULT_BASE;
  const root = `${base}/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}`;
  const authHeaders = { Authorization: `Bearer ${config.token}` };

  return {
    async get(key) {
      const res = await fetchImpl(`${root}/values/${encodeURIComponent(key)}`, {
        headers: authHeaders,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`KV GET ${key} failed: ${res.status} ${await res.text()}`);
      }
      return res.text();
    },

    async put(key, value) {
      const res = await fetchImpl(`${root}/values/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "text/plain" },
        body: value,
      });
      if (!res.ok) {
        throw new Error(`KV PUT ${key} failed: ${res.status} ${await res.text()}`);
      }
    },
  };
}
