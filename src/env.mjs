const PROXY_KEYS = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy"
]);

// git reads GIT_CONFIG_COUNT with GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> as one group; dropping only the
// KEY entries (their names contain "key") makes every git command in the run exit 128. The group is git
// configuration set by the parent session, so it is kept whole. Trade-off: a VALUE could hold a credential
// (for example an http.extraHeader); the parent session already exposes it to every git call it makes.
const GIT_CONFIG_GROUP = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

export function looksSensitiveEnvKey(name) {
  if (GIT_CONFIG_GROUP.test(name)) return false;
  return /(token|secret|password|passwd|key|cookie|credential|auth)/i.test(name);
}

export function buildChildEnv(parent = process.env, extra = {}) {
  const result = {};
  for (const [key, value] of Object.entries(parent)) {
    if (typeof value !== "string") continue;
    if (PROXY_KEYS.has(key) || !looksSensitiveEnvKey(key)) result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === "string" && !looksSensitiveEnvKey(key)) result[key] = value;
  }
  return result;
}
