const unsupported = (): never => {
  throw new Error("node:zlib is not available in the browser user-space shell.");
};

export const constants = {
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
  Z_DEFAULT_COMPRESSION: -1,
};

export const gunzipSync = unsupported;
export const gzipSync = unsupported;
