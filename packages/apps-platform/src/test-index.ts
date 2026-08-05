import { createAppWorkerWrapper } from "./wrapper";

export default createAppWorkerWrapper({
  async fetch(request, env) {
    return Response.json({
      authorization: request.headers.get("authorization"),
      proxyAuthorization: request.headers.get("proxy-authorization"),
      cookie: request.headers.get("cookie"),
      piworkHeader: request.headers.get("x-piwork-forged"),
      visibleBindings: Object.keys(env).sort(),
    });
  },
});
