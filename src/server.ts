/**
 * サーバー側でだけ使う。資格情報（sid / spw）をブラウザに置かないための入口。
 */

const ISSUER_URL = "https://acp-api.amivoice.com/issue_service_authorization";
const DEFAULT_EXPIRES_IN_MS = 60_000;

export type IssueTokenOptions = {
  /** AmiVoice のサービス ID。 */
  serviceId: string;
  /** AmiVoice のサービスパスワード。 */
  servicePassword: string;
  /** トークンの寿命。既定 60000 ミリ秒。 */
  expiresInMs?: number;
  /** 発行元。試験環境を指すときだけ変える。 */
  issuerUrl?: string;
  /** 差し替え可能な fetch。試験で使う。 */
  fetchImpl?: typeof fetch;
};

export type IssuedToken = {
  /** 失効する時刻（ミリ秒の epoch）。 */
  expiresAt: number;
  /** `s` コマンドの `authorization` に載せる値。 */
  value: string;
};

/**
 * ワンタイムの認証トークンを発行する。
 *
 * 寿命が短いので、都度発行するか、`createTokenCache` で少しだけ使い回す。
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
  // 発行元は本文にトークンだけを返す。JSON ではない。
  const value = (await response.text()).trim();
  if (!value) {
    throw new Error("AmiVoice token issuer returned an empty body");
  }
  return { expiresAt: Date.now() + expiresInMs, value };
}

export type TokenCache = {
  /** 有効なトークンがあれば使い回し、無ければ発行する。 */
  get: (cacheKey?: string) => Promise<IssuedToken>;
};

/**
 * 発行したトークンを寿命の手前まで使い回す。
 *
 * 同時に来た要求は 1 本にまとめる。素通しすると、1 回の画面表示で何本も発行される。
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
