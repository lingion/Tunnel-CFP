export async function handleGateway(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/health") {
    return Response.json({ status: "ok" });
  }
  return Response.json({ error: { code: "NOT_FOUND", message: "unknown endpoint" } }, { status: 404 });
}
