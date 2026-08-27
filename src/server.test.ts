import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenCache, issueAmiVoiceToken } from "./server.js";

// A Response body can be read only once, so build a new one per call.
function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

const credentials = { serviceId: "SID", servicePassword: "SPW" };

describe("issueAmiVoiceToken", () => {
  it("posts the credentials as a form", async () => {
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

  it("trims whitespace around the body", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("  TOKEN \n")));
    const token = await issueAmiVoiceToken({ ...credentials, fetchImpl });
    expect(token.value).toBe("TOKEN");
  });

  it("derives the expiry from the lifetime", async () => {
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

  it("throws on a failed response", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("bad credentials", { status: 401 })),
      );
    await expect(
      issueAmiVoiceToken({ ...credentials, fetchImpl }),
    ).rejects.toThrow(/401.*bad credentials/);
  });

  it("throws on an empty body", async () => {
    // An empty 200 does happen. Letting it through means connecting unauthenticated
    // and failing for no visible reason.
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

  it("reuses a token while it is still valid", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN")));
    const cache = createTokenCache({ ...credentials, fetchImpl });

    await cache.get();
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-issues shortly before expiry", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN")));
    const cache = createTokenCache({
      ...credentials,
      expiresInMs: 60_000,
      fetchImpl,
      refreshAheadMs: 10_000,
    });
    await cache.get();

    // 11 seconds before expiry: still reused.
    vi.setSystemTime(new Date("2026-08-27T00:00:49Z"));
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 9 seconds before expiry: re-issued.
    vi.setSystemTime(new Date("2026-08-27T00:00:51Z"));
    await cache.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent requests into one", async () => {
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

  it("keeps a separate token per cache key", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okResponse("TOKEN")));
    const cache = createTokenCache({ ...credentials, fetchImpl });
    await cache.get("user-a");
    await cache.get("user-b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
