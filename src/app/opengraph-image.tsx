import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "amivoice-realtime";

export const size = { height: 630, width: 1200 };

export const contentType = "image/png";

const TITLE = "amivoice-realtime";
const DESCRIPTION =
  "Realtime speech recognition over the AmiVoice WebSocket interface.";

export default async function Image() {
  /* The same Sora the site uses for headings, cut down to the characters this
     card shows. Change the copy and rebuild it per assets/README.md. */
  const font = await readFile(
    join(process.cwd(), "assets/Sora-700-subset.ttf"),
  );

  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#0b0b0f",
        color: "#ffffff",
        display: "flex",
        height: "100%",
        padding: "0 80px",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          width: 580,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 56,
            fontWeight: 700,
            letterSpacing: -1,
          }}
        >
          {TITLE}
        </div>
        <div
          style={{
            color: "#a1a1aa",
            display: "flex",
            fontSize: 28,
            lineHeight: 1.4,
            marginTop: 26,
          }}
        >
          {DESCRIPTION}
        </div>
        <div
          style={{
            color: "#71717a",
            display: "flex",
            fontSize: 26,
            marginTop: 44,
          }}
        >
          kkweb.io
        </div>
      </div>

      {/* Speech going in, interim then final coming back. A name and a line of
          copy alone would make every card in the set look the same. */}
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flex: 1,
          gap: 24,
          justifyContent: "center",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
          {[30, 62, 96, 48, 78, 36].map((height) => (
            <div
              key={height}
              style={{
                background: "#a78bfa",
                borderRadius: 999,
                display: "flex",
                height,
                opacity: 0.4 + (height / 96) * 0.6,
                width: 10,
              }}
            />
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[
            { color: "#71717a", label: "partial", width: 150 },
            { color: "#71717a", label: "partial", width: 190 },
            { color: "#e4e4e7", label: "final", width: 230 },
          ].map((row) => (
            <div
              key={`${row.label}-${row.width}`}
              style={{
                alignItems: "center",
                background: "#15151c",
                border: "1px solid #26262f",
                borderRadius: 14,
                color: row.color,
                display: "flex",
                fontSize: 20,
                height: 50,
                padding: "0 18px",
                width: row.width,
              }}
            >
              {row.label}
            </div>
          ))}
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [{ data: font, name: "Sora", style: "normal", weight: 700 }],
    },
  );
}
