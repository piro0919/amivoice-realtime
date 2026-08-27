import { ImageResponse } from "next/og";

export const size = { height: 180, width: 180 };

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
        display: "flex",
        gap: 8,
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      {[54, 92, 36, 74].map((height) => (
        <div
          key={height}
          style={{
            background: "#ffffff",
            borderRadius: 999,
            display: "flex",
            height,
            width: 14,
          }}
        />
      ))}
    </div>,
    { ...size },
  );
}
