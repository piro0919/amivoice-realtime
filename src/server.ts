/**
 * Server-side only. This entry point exists so the credentials (sid / spw) never
 * reach the browser.
 */

const ISSUER_URL = "https://acp-api.amivoice.com/issue_service_authorization";
const DEFAULT_EXPIRES_IN_MS = 60_000;

export type IssueTokenOptions = {
  /** The AmiVoice service ID. */
  serviceId: string;
  /** The AmiVoice service password. */
  servicePassword: string;
  /** Token lifetime. Defaults to 60000 ms. */
  expiresInMs?: number;
  /** The issuer. Change it only to point at a test environment. */
  issuerUrl?: string;
  /** A replaceable fetch, for tests. */
  fetchImpl?: typeof fetch;
};

export type IssuedToken = {
  /** When it expires, as epoch milliseconds. */
  expiresAt: number;
  /** The value to put in the `s` command's `authorization`. */
  value: string;
};

/**
 * Issue a single-use authentication token.
 *
 * They are short-lived, so either issue one per connection or reuse one briefly
 * with `createTokenCache`.
 */
export async function issueAmiVoiceToken({
  expiresInMs = DEFAULT_EXPIRES_IN_MS,
  fetchImpl = fetch,
  issuerUrl = ISSUER_URL,
  serviceId,
  servicePassword,
}: IssueTokenOptions): Promise<IssuedToken> {
  const form = new URLSearchParams();
  form.set("sid", serviceId);
  form.set("spw", servicePassword);
  form.set("epi", String(expiresInMs));

  const response = await fetchImpl(issuerUrl, {
    body: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `AmiVoice token issuer returned ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  // The issuer returns the token alone in the body. It is not JSON.
  const value = (await response.text()).trim();
  if (!value) {
    throw new Error("AmiVoice token issuer returned an empty body");
  }
  return { expiresAt: Date.now() + expiresInMs, value };
}

export type TokenCache = {
  /** Reuse a valid token if there is one, otherwise issue a new one. */
  get: (cacheKey?: string) => Promise<IssuedToken>;
};

/**
 * Reuse an issued token until shortly before it expires.
 *
 * Concurrent requests collapse into one. Letting them through would issue several
 * tokens for a single page view.
 */
export function createTokenCache(
  options: IssueTokenOptions & { refreshAheadMs?: number },
): TokenCache {
  const refreshAheadMs = options.refreshAheadMs ?? 10_000;
  const cache = new Map<string, IssuedToken>();
  const inFlight = new Map<string, Promise<IssuedToken>>();

  return {
    get: async (cacheKey = "default"): Promise<IssuedToken> => {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt - refreshAheadMs > Date.now()) {
        return cached;
      }
      const pending = inFlight.get(cacheKey);
      if (pending) return pending;

      const promise = issueAmiVoiceToken(options)
        .then((token) => {
          cache.set(cacheKey, token);
          return token;
        })
        .finally(() => {
          inFlight.delete(cacheKey);
        });
      inFlight.set(cacheKey, promise);
      return promise;
    },
  };
}
