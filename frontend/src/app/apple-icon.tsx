import { ImageResponse } from "next/og";

// Larger variant for iOS home-screen / PWA install icons — same mark as
// icon.tsx, sized per Apple's convention.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 96,
            fontWeight: 700,
            fontFamily: "Georgia, serif",
            fontStyle: "italic",
            color: "#F0A868",
            letterSpacing: "-6px",
          }}
        >
          N
        </div>
      </div>
    ),
    { ...size },
  );
}
