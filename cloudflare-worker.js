const SUPABASE_MCP =
  "https://prctfnpbftjepdckwpao.supabase.co/functions/v1/open-brain-gemini-oauth";
const SUPABASE_AUTH =
  "https://prctfnpbftjepdckwpao.supabase.co/auth/v1";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin;
    const resourceUrl = `${origin}/mcp`;
    const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

    // RFC 9728 protected-resource metadata. Point Gemini to this Worker as
    // the OAuth discovery origin so we can expose Supabase's DCR endpoint
    // in a form Gemini understands.
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json(
        {
          resource: resourceUrl,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        },
        {
          headers: {
            "Cache-Control": "public, max-age=60",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // RFC 8414 authorization-server metadata for Gemini.
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return Response.json(
        {
          issuer: origin,
          authorization_endpoint: `${SUPABASE_AUTH}/oauth/authorize`,
          token_endpoint: `${SUPABASE_AUTH}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_basic",
            "client_secret_post",
          ],
          scopes_supported: ["openid", "email", "profile"],
        },
        {
          headers: {
            "Cache-Control": "public, max-age=60",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // RFC 7591 Dynamic Client Registration. Supabase handles the actual
    // registration; this route only forwards Google's request.
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      const upstream = await fetch(`${SUPABASE_AUTH}/oauth/clients/register`, {
        method: "POST",
        headers: {
          "Content-Type": request.headers.get("Content-Type") || "application/json",
          "Accept": "application/json",
        },
        body: request.body,
      });

      const headers = new Headers(upstream.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
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
