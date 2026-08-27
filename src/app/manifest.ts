import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#18181b",
    display: "standalone",
    icons: [
      { purpose: "any", sizes: "any", src: "/icon.svg", type: "image/svg+xml" },
      { sizes: "180x180", src: "/apple-icon", type: "image/png" },
    ],
    name: "amivoice-realtime",
    orientation: "portrait",
    short_name: "amivoice",
    start_url: "/",
    theme_color: "#18181b",
  };
}
