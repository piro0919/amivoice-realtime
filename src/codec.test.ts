import { describe, expect, it } from "vitest";
import {
  buildAudioPacket,
  buildStartCommand,
  concatInt16,
  floatToInt16,
  formatProfileWords,
  int16ToBigEndianBytes,
  parseResultBody,
  resample,
  splitPacket,
} from "./codec.js";

describe("floatToInt16", () => {
  it("端の値を飽和させる", () => {
    expect(Array.from(floatToInt16(new Float32Array([1, -1])))).toEqual([
      32767, -32768,
    ]);
  });

  it("範囲の外を切り詰める", () => {
    expect(Array.from(floatToInt16(new Float32Array([2, -2])))).toEqual([
      32767, -32768,
    ]);
  });
});

describe("int16ToBigEndianBytes", () => {
  it("上位バイトを先に置く", () => {
    // 0x1234 が 0x12, 0x34 の順で出ること。逆にすると雑音として認識される。
    expect(Array.from(int16ToBigEndianBytes(new Int16Array([0x1234])))).toEqual([
      0x12, 0x34,
    ]);
  });

  it("負の値も 2 の補数のまま並べる", () => {
    expect(Array.from(int16ToBigEndianBytes(new Int16Array([-2])))).toEqual([
      0xff, 0xfe,
    ]);
  });
});

describe("buildAudioPacket", () => {
  it("先頭に 'p' を置く", () => {
    const packet = buildAudioPacket(new Int16Array([0x0102]));
    expect(packet[0]).toBe(0x70);
    expect(Array.from(packet.slice(1))).toEqual([0x01, 0x02]);
  });
});

describe("resample", () => {
  it("同じレートなら手を加えない", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("半分のレートへ落とすと長さが半分になる", () => {
    const input = new Float32Array([0, 0.25, 0.5, 0.75]);
    const output = resample(input, 32000, 16000);
    expect(output.length).toBe(2);
    expect(output[0]).toBeCloseTo(0);
    expect(output[1]).toBeCloseTo(0.5);
  });

  it("末尾を超えて読まない", () => {
    const output = resample(new Float32Array([1, 1, 1]), 16000, 11000);
    expect(Array.from(output).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("concatInt16", () => {
  it("順序を保って連結する", () => {
    const joined = concatInt16(new Int16Array([1, 2]), new Int16Array([3]));
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });
});

describe("splitPacket", () => {
  it("区切りの空白を落とす", () => {
    expect(splitPacket('U {"text":"あ"}')).toEqual({
      body: '{"text":"あ"}',
      tag: "U",
    });
  });

  it("本体を持たない応答を空文字にする", () => {
    expect(splitPacket("e")).toEqual({ body: "", tag: "e" });
  });

  it("空白の無い本体も読む", () => {
    expect(splitPacket("S6200")).toEqual({ body: "6200", tag: "S" });
  });
});

describe("parseResultBody", () => {
  it("text を取り出す", () => {
    expect(parseResultBody('{"text":"おはよう"}')).toBe("おはよう");
  });

  it("results の先頭からも取り出す", () => {
    expect(parseResultBody('{"results":[{"text":"はい"}]}')).toBe("はい");
  });

  it("code を持つ本体は認識結果として扱わない", () => {
    expect(parseResultBody('{"code":"o","message":"failed"}')).toBeUndefined();
  });

  it("空の text を落とす", () => {
    expect(parseResultBody('{"text":"  "}')).toBeUndefined();
  });

  it("JSON でない本体の制御文字を剥がす", () => {
    expect(parseResultBody("\x01\x01\x01\x01\x01ねこ")).toBe("ねこ");
  });
});

describe("buildStartCommand", () => {
  it("既定の音声形式とエンジンを並べる", () => {
    expect(buildStartCommand({ token: "T" })).toBe(
      "s MSB16K -a-general resultUpdatedInterval=1000 authorization=T",
    );
  });

  it("単語登録を引用符で囲む", () => {
    // 囲まないと、空白を含む単語の 2 語目以降が別のパラメータとして読まれる。
    const command = buildStartCommand({
      profileWords: "個浴槽 こよくそう 固有名詞",
      token: "T",
    });
    expect(command).toContain('profileWords="個浴槽 こよくそう 固有名詞"');
  });

  it("profileId は指定したときだけ載せる", () => {
    expect(buildStartCommand({ token: "T" })).not.toContain("profileId");
    expect(buildStartCommand({ profileId: "acme", token: "T" })).toContain(
      "profileId=acme",
    );
  });

  it("追加のパラメータを並べる", () => {
    expect(
      buildStartCommand({ extra: { keepFillerToken: 1 }, token: "T" }),
    ).toContain("keepFillerToken=1");
  });
});

describe("formatProfileWords", () => {
  it("縦棒で区切る", () => {
    expect(
      formatProfileWords([
        { spoken: "こよくそう", wordClass: "固有名詞", written: "個浴槽" },
        { spoken: "たんい", written: "単位" },
      ]),
    ).toBe("個浴槽 こよくそう 固有名詞|単位 たんい");
  });
});
