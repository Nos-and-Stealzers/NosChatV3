// Discord-style lightweight inline markdown renderer for message content.
// Deliberately regex-based rather than pulling in a markdown dependency —
// the supported subset (bold/italic/underline/strikethrough/inline code/
// code blocks/spoilers/auto-linked URLs) covers what Discord actually
// renders in a chat message and doesn't need a full CommonMark parser.
// Shared by both guild-view.tsx and chat-app.tsx so DM and guild messages
// format identically.
import type { ReactNode } from "react";

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

// Applies inline formatting (not code blocks) to a plain text run: bold,
// italic, underline, strikethrough, inline code, spoilers, and bare URLs
// as clickable links. Order matters — code spans are matched first so
// formatting markers inside them aren't touched, matching Discord.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Single combined pass using alternation so overlapping-looking markers
  // (e.g. ** vs *) are tried longest-first per Discord's own precedence.
  const re =
    /(`[^`\n]+`)|(\*\*\*[^*\n]+\*\*\*)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\|\|[^|\n]+\|\|)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  const pushPlain = (segment: string) => {
    if (!segment) return;
    // Auto-link bare URLs within plain (non-marker) segments.
    let last = 0;
    let urlMatch: RegExpExecArray | null;
    URL_RE.lastIndex = 0;
    while ((urlMatch = URL_RE.exec(segment))) {
      if (urlMatch.index > last) nodes.push(segment.slice(last, urlMatch.index));
      nodes.push(
        <a
          key={`${keyPrefix}-url-${i++}`}
          href={urlMatch[0]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#F0A868] underline decoration-[#F0A868]/40 underline-offset-2 hover:decoration-[#F0A868]"
        >
          {urlMatch[0]}
        </a>,
      );
      last = urlMatch.index + urlMatch[0].length;
    }
    if (last < segment.length) nodes.push(segment.slice(last));
  };

  while ((match = re.exec(text))) {
    if (match.index > lastIndex) pushPlain(text.slice(lastIndex, match.index));
    const [, code, bolditalic, bold, underline, italic, strike, spoiler] = match;
    const key = `${keyPrefix}-fmt-${i++}`;
    if (code) {
      nodes.push(
        <code key={key} className="rounded bg-[#1E232C] px-1 py-0.5 font-mono text-[0.85em] text-[#F0A868]">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bolditalic) {
      nodes.push(
        <strong key={key} className="italic">
          {bolditalic.slice(3, -3)}
        </strong>,
      );
    } else if (bold) {
      nodes.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    } else if (underline) {
      nodes.push(<span key={key} className="underline">{underline.slice(2, -2)}</span>);
    } else if (italic) {
      nodes.push(<em key={key}>{italic.slice(1, -1)}</em>);
    } else if (strike) {
      nodes.push(<span key={key} className="line-through opacity-70">{strike.slice(2, -2)}</span>);
    } else if (spoiler) {
      nodes.push(<Spoiler key={key}>{spoiler.slice(2, -2)}</Spoiler>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) pushPlain(text.slice(lastIndex));
  return nodes;
}

function Spoiler({ children }: { children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      data-revealed="false"
      onClick={(e) => {
        e.currentTarget.dataset.revealed = e.currentTarget.dataset.revealed === "true" ? "false" : "true";
      }}
      className="cursor-pointer rounded bg-[#1E232C] px-1 text-transparent transition-colors data-[revealed=true]:text-inherit data-[revealed=true]:bg-[#2A2F3A]/60 select-none data-[revealed=true]:select-text"
      title="Click to reveal"
    >
      {children}
    </span>
  );
}

/**
 * Renders Discord-style markdown for a full message body: splits on
 * fenced ```code blocks``` first (which span lines and are never
 * inline-formatted inside), then applies renderInline to every other
 * line, preserving line breaks. `resolveMention`, if given, turns a
 * `<@userId>` token into a highlighted @name chip (used for real
 * @mentions); without it, mention tokens render as literal text.
 */
export function renderMarkdown(
  content: string,
  keyPrefix = "md",
  opts?: { resolveMention?: (userId: string) => string | null; currentUserId?: string | null },
): ReactNode {
  const blockParts = content.split(/(```[\s\S]*?```|<@[a-f0-9-]{36}>)/g);
  const out: ReactNode[] = [];
  let blockIdx = 0;
  for (const part of blockParts) {
    const mentionMatch = /^<@([a-f0-9-]{36})>$/.exec(part);
    if (mentionMatch && opts?.resolveMention) {
      const uid = mentionMatch[1];
      const label = opts.resolveMention(uid);
      if (label) {
        const isMe = opts.currentUserId === uid;
        out.push(
          <span
            key={`${keyPrefix}-mention-${blockIdx++}`}
            className={`rounded px-1 font-medium ${
              isMe
                ? "bg-[#F0A868]/25 text-[#F0A868]"
                : "bg-[#5865F2]/20 text-[#8EA1FF] hover:bg-[#5865F2]/30"
            }`}
          >
            @{label}
          </span>,
        );
        continue;
      }
    }
    if (part.startsWith("```") && part.endsWith("```") && part.length >= 6) {
      const inner = part.slice(3, -3).replace(/^[a-zA-Z0-9_+-]*\n/, "");
      out.push(
        <pre
          key={`${keyPrefix}-block-${blockIdx++}`}
          className="my-1 overflow-x-auto rounded-lg bg-[#0F1217] px-3 py-2 font-mono text-[0.85em] text-[#C7CCD6]"
        >
          <code>{inner}</code>
        </pre>,
      );
      continue;
    }
    const lines = part.split("\n");
    lines.forEach((line, li) => {
      out.push(...renderInline(line, `${keyPrefix}-b${blockIdx}-l${li}`));
      if (li < lines.length - 1) out.push(<br key={`${keyPrefix}-br-${blockIdx}-${li}`} />);
    });
  }
  return out;
}
