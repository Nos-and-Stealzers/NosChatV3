"use client";

import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";

// Real attachment renderer for DM/guild messages: fetches the attachment's
// bytes (authenticated — attachments aren't public like guild icons) into a
// blob: URL once, shows an inline <img> for image mimes and a download chip
// for everything else. `load` is injected per-context (DM vs guild channel
// hit different backend routes) rather than baked in here.
export function AttachmentPreview({
  attachment,
  load,
}: {
  attachment: { filename: string; mime: string; size: number };
  load: () => Promise<string>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    load()
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isImage = attachment.mime.startsWith("image/");
  const sizeLabel =
    attachment.size > 1024 * 1024
      ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(attachment.size / 1024))} KB`;

  if (failed) {
    return (
      <div className="mt-1.5 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-xs text-[#8B93A1]">
        Failed to load attachment
      </div>
    );
  }

  if (isImage) {
    return (
      <a
        href={url ?? undefined}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 block max-w-[320px] overflow-hidden rounded-lg border border-white/[0.06]"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={attachment.filename} className="max-h-[280px] w-full object-cover" />
        ) : (
          <div className="flex h-32 items-center justify-center bg-black/20 text-xs text-[#8B93A1]">
            Loading image…
          </div>
        )}
      </a>
    );
  }

  return (
    <a
      href={url ?? undefined}
      download={attachment.filename}
      className="mt-1.5 flex max-w-[320px] items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-xs text-[#C7CCD6] transition-colors hover:bg-black/30"
    >
      <Paperclip className="size-3.5 shrink-0 text-[#8B93A1]" />
      <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
      <span className="shrink-0 text-[#8B93A1]">{sizeLabel}</span>
    </a>
  );
}
