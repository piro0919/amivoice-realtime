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
} from "../src/codec";

describe("floatToInt16", () => {
  it("saturates at the extremes", () => {
    expect(Array.from(floatToInt16(new Float32Array([1, -1])))).toEqual([
      32767, -32768,
    ]);
  });

  it("clamps values outside the range", () => {
    expect(Array.from(floatToInt16(new Float32Array([2, -2])))).toEqual([
      32767, -32768,
    ]);
  });
});

describe("int16ToBigEndianBytes", () => {
  it("puts the high byte first", () => {
    // 0x1234 must come out as 0x12 then 0x34. Reversed, speech becomes noise.
    expect(Array.from(int16ToBigEndianBytes(new Int16Array([0x1234])))).toEqual(
      [0x12, 0x34],
    );
  });

  it("keeps negatives in two's complement", () => {
    expect(Array.from(int16ToBigEndianBytes(new Int16Array([-2])))).toEqual([
      0xff, 0xfe,
    ]);
  });
});

describe("buildAudioPacket", () => {
  it("puts 'p' at the front", () => {
    const packet = buildAudioPacket(new Int16Array([0x0102]));
    expect(packet[0]).toBe(0x70);
    expect(Array.from(packet.slice(1))).toEqual([0x01, 0x02]);
  });
});

describe("resample", () => {
  it("leaves the input untouched at the same rate", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("halves the length when halving the rate", () => {
    const input = new Float32Array([0, 0.25, 0.5, 0.75]);
    const output = resample(input, 32000, 16000);
    expect(output.length).toBe(2);
    expect(output[0]).toBeCloseTo(0);
    expect(output[1]).toBeCloseTo(0.5);
  });

  it("never reads past the end", () => {
    const output = resample(new Float32Array([1, 1, 1]), 16000, 11000);
    expect(Array.from(output).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("concatInt16", () => {
  it("concatenates in order", () => {
    const joined = concatInt16(new Int16Array([1, 2]), new Int16Array([3]));
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });
});

describe("splitPacket", () => {
  it("drops the separating space", () => {
    expect(splitPacket('U {"text":"あ"}')).toEqual({
      body: '{"text":"あ"}',
      tag: "U",
    });
  });

  it("gives an empty body for a bodyless response", () => {
    expect(splitPacket("e")).toEqual({ body: "", tag: "e" });
  });

  it("reads a body with no space before it", () => {
    expect(splitPacket("S6200")).toEqual({ body: "6200", tag: "S" });
  });
});

describe("parseResultBody", () => {
  it("extracts text", () => {
    expect(parseResultBody('{"text":"おはよう"}')).toBe("おはよう");
  });

  it("extracts from the first result too", () => {
    expect(parseResultBody('{"results":[{"text":"はい"}]}')).toBe("はい");
  });

  it("does not treat a body with a code as a result", () => {
    expect(parseResultBody('{"code":"o","message":"failed"}')).toBeUndefined();
  });

  it("drops empty text", () => {
    expect(parseResultBody('{"text":"  "}')).toBeUndefined();
  });

  it("strips control characters from a non-JSON body", () => {
    expect(parseResultBody("\x01\x01\x01\x01\x01ねこ")).toBe("ねこ");
  });
});

describe("buildStartCommand", () => {
  it("lists the default format and engine", () => {
    expect(buildStartCommand({ token: "T" })).toBe(
      "s MSB16K -a-general resultUpdatedInterval=1000 authorization=T",
    );
  });

  it("quotes registered words", () => {
    // Unquoted, everything after the first word of a spaced entry is read as a
    // separate parameter.
    const command = buildStartCommand({
      profileWords: "個浴槽 こよくそう 固有名詞",
      token: "T",
    });
    expect(command).toContain('profileWords="個浴槽 こよくそう 固有名詞"');
  });

  it("includes profileId only when given", () => {
    expect(buildStartCommand({ token: "T" })).not.toContain("profileId");
    expect(buildStartCommand({ profileId: "acme", token: "T" })).toContain(
      "profileId=acme",
    );
  });

  it("appends extra parameters", () => {
    expect(
      buildStartCommand({ extra: { keepFillerToken: 1 }, token: "T" }),
    ).toContain("keepFillerToken=1");
  });
});

describe("formatProfileWords", () => {
  it("separates entries with a pipe", () => {
    expect(
      formatProfileWords([
        { spoken: "こよくそう", wordClass: "固有名詞", written: "個浴槽" },
        { spoken: "たんい", written: "単位" },
      ]),
    ).toBe("個浴槽 こよくそう 固有名詞|単位 たんい");
  });
});
