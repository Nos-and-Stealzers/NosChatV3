import { ImageResponse } from "next/og";

// Next.js file-convention route — auto-generates /icon (favicon +
// apple-touch-icon sizes) with zero extra config. No static icon file
// existed anywhere in the repo before this, so browser tabs/bookmarks/
// PWA installs were all showing a blank placeholder square.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(180deg, #1E232C 0%, #12151A 100%)",
          borderRadius: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 34,
            fontWeight: 700,
            fontFamily: "Georgia, serif",
            fontStyle: "italic",
            color: "#F0A868",
            letterSpacing: "-2px",
          }}
        >
          N
        </div>
      </div>
    ),
    { ...size },
  );
}
