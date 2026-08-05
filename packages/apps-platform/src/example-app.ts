export default {
  fetch(_request: Request, env: Record<string, unknown>): Response {
    return Response.json({ ok: true, bindings: Object.keys(env).sort() });
  },
};
