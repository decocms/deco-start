/**
 * Handles /deco/invoke -- executes a loader or action by key.
 * Commerce loaders must be registered via registerCommerceLoader() before use.
 *
 * Loaders receive `(props, request)` so they can access cookies, headers,
 * auth tokens, etc. from the original HTTP request.
 */

export type InvokeLoader = (props: any, request: Request) => Promise<any>;

let getRegisteredLoaders: () => Record<string, InvokeLoader> = () => ({});

export function setInvokeLoaders(getter: () => Record<string, InvokeLoader>) {
  getRegisteredLoaders = getter;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export async function handleInvoke(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/deco/invoke/");
  const invokeKey = pathParts[1] || "";

  const loaders = getRegisteredLoaders();

  let body: any = {};
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      // no body
    }
  }

  // Single invoke by key
  if (invokeKey) {
    const loader = loaders[invokeKey];
    if (!loader) {
      return new Response(JSON.stringify({ error: `Unknown loader: ${invokeKey}` }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    try {
      const result = await loader(body, request);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  }

  // Batch invoke
  if (request.method === "POST" && typeof body === "object") {
    const results: Record<string, any> = {};

    for (const [key, payload] of Object.entries(body)) {
      const loaderKey = (payload as any)?.__resolveType || key;
      const loader = loaders[loaderKey];

      if (loader) {
        try {
          results[key] = await loader(payload, request);
        } catch (error) {
          results[key] = { error: (error as Error).message };
        }
      } else {
        results[key] = { error: `Unknown loader: ${loaderKey}` };
      }
    }

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }

  return new Response(JSON.stringify({ error: "No invoke key specified" }), {
    status: 400,
    headers: JSON_HEADERS,
  });
}
