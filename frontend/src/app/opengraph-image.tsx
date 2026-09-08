import { ImageResponse } from "next/og";

// Default Open Graph share-preview image — used when a NosChat URL (e.g.
// an /invite/CODE link) gets pasted into Discord/iMessage/Slack/etc. and
// they fetch a link-preview card. Without this, shared invite links show
// a bare title with no visual, same problem as the missing favicon.
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(160deg, #1E232C 0%, #12151A 65%)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 160,
            height: 160,
            borderRadius: 36,
            background: "linear-gradient(180deg, #262C37 0%, #171B22 100%)",
            marginBottom: 36,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 92,
              fontWeight: 700,
              fontFamily: "Georgia, serif",
              fontStyle: "italic",
              color: "#F0A868",
            }}
          >
            N
          </div>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 64,
            fontWeight: 600,
            fontFamily: "Georgia, serif",
            fontStyle: "italic",
            color: "#E8EAED",
            letterSpacing: "-1px",
          }}
        >
          NosChat
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 14,
            fontSize: 24,
            fontFamily: "monospace",
            textTransform: "uppercase",
            letterSpacing: "3px",
            color: "#8B93A1",
          }}
        >
          Self-hosted chat
        </div>
      </div>
    ),
    { ...size },
  );
}
