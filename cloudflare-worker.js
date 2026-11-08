const SUPABASE_MCP =
  "https://prctfnpbftjepdckwpao.supabase.co/functions/v1/open-brain-gemini-oauth";
const AUTHORIZATION_SERVER =
  "https://prctfnpbftjepdckwpao.supabase.co/auth/v1";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin;
    const resourceUrl = `${origin}/mcp`;
    const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

    // RFC 9728 OAuth Protected Resource Metadata.
    // Gemini may request either the root well-known path or a path-specific variant.
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json(
        {
          resource: resourceUrl,
          authorization_servers: [AUTHORIZATION_SERVER],
          bearer_methods_supported: ["header"],
        },
        {
          headers: {
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Gemini verifies the MCP URL with HEAD before beginning discovery.
    if (url.pathname === "/mcp" && request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Open Brain Gemini OAuth gateway", { status: 200 });
    }

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("host", new URL(SUPABASE_MCP).host);

    const upstream = await fetch(SUPABASE_MCP, {
      method: request.method,
      headers: upstreamHeaders,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
    });

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    // Keep OAuth discovery on this public gateway rather than the Supabase
    // project root, which requires an API key for unrelated routes.
    if (upstream.status === 401) {
      responseHeaders.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${metadataUrl}"`
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};
