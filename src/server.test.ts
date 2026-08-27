import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenCache, issueAmiVoiceToken } from "./server.js";

// Response の本文は 1 回しか読めない。呼ばれるたびに作り直す。
function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

const credentials = { serviceId: "SID", servicePassword: "SPW" };

describe("issueAmiVoiceToken", () => {
  it("資格情報をフォームで送る", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN\n")));
    await issueAmiVoiceToken({ ...credentials, fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://acp-api.amivoice.com/issue_service_authorization",
    );
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("sid")).toBe("SID");
    expect(body.get("spw")).toBe("SPW");
    expect(body.get("epi")).toBe("60000");
  });

  it("本文の前後の空白を落とす", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("  TOKEN \n")));
    const token = await issueAmiVoiceToken({ ...credentials, fetchImpl });
    expect(token.value).toBe("TOKEN");
  });

  it("失効の時刻を寿命から決める", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    try {
      const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN")));
      const token = await issueAmiVoiceToken({
        ...credentials,
        expiresInMs: 30_000,
        fetchImpl,
      });
      expect(token.expiresAt).toBe(Date.parse("2026-08-27T00:00:30Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("失敗した応答を投げる", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("bad credentials", { status: 401 })),
      );
    await expect(
      issueAmiVoiceToken({ ...credentials, fetchImpl }),
    ).rejects.toThrow(/401.*bad credentials/);
  });

  it("空の本文を投げる", async () => {
    // 200 で空を返されることがある。これを通すと、認証されないまま
    // 接続して原因の分からない失敗になる。
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("   ")));
    await expect(
      issueAmiVoiceToken({ ...credentials, fetchImpl }),
    ).rejects.toThrow(/empty body/);
  });
});

describe("createTokenCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("寿命の内は使い回す", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN")));
    const cache = createTokenCache({ ...credentials, fetchImpl });

    await cache.get();
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("寿命の手前で取り直す", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN")));
    const cache = createTokenCache({
      ...credentials,
      expiresInMs: 60_000,
      fetchImpl,
      refreshAheadMs: 10_000,
    });
    await cache.get();

    // 失効の 11 秒前。まだ使う。
    vi.setSystemTime(new Date("2026-08-27T00:00:49Z"));
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 失効の 9 秒前。取り直す。
    vi.setSystemTime(new Date("2026-08-27T00:00:51Z"));
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("同時に来た要求を 1 本にまとめる", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const cache = createTokenCache({ ...credentials, fetchImpl });

    const both = Promise.all([cache.get(), cache.get()]);
    resolveFetch(okResponse("TOKEN"));
    const [first, second] = await both;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.value).toBe("TOKEN");
    expect(second.value).toBe("TOKEN");
  });

  it("鍵ごとに分けて持つ", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN")));
    const cache = createTokenCache({ ...credentials, fetchImpl });
    await cache.get("user-a");
    await cache.get("user-b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
