const proxyEnvironmentKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

for (const key of proxyEnvironmentKeys) {
  const value = process.env[key];
  if (!value) continue;
  try {
    const proxyUrl = new URL(value);
    if (proxyUrl.hostname !== "localhost") continue;
    proxyUrl.hostname = "127.0.0.1";
    process.env[key] = proxyUrl.toString();
  } catch {
    // Leave malformed values untouched so the native client reports them.
  }
}
