/**
 * Handles /deco/invoke -- executes a loader or action by key.
 * Commerce loaders must be registered via registerCommerceLoader() before use.
 */

// Access the commerce loaders that were registered by the site/apps
let getRegisteredLoaders: () => Record<string, (props: any) => Promise<any>> = () => ({});

export function setInvokeLoaders(getter: () => Record<string, (props: any) => Promise<any>>) {
  getRegisteredLoaders = getter;
}

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
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await loader(body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: (error as Error).message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
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
          results[key] = await loader(payload);
        } catch (error) {
          results[key] = { error: (error as Error).message };
        }
      } else {
        results[key] = { error: `Unknown loader: ${loaderKey}` };
      }
    }

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "No invoke key specified" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
