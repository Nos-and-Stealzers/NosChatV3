"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Search } from "lucide-react";
import { searchGifs, type GifResult } from "@/lib/backend-api";

// Discord-style GIF picker: search box + a responsive grid of preview
// GIFs. Debounced search-as-you-type, falls back to Tenor's "featured"
// feed when the query is empty (same UX as Discord's own picker showing
// trending GIFs before you type anything). Requires the backend's
// TENOR_API_KEY to be configured — shows a clear inline message instead
// of silently failing if it isn't.
export function GifPicker({ onPick }: { onPick: (url: string) => void }) {
  const { getToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(query);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function runSearch(q: string) {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const { results } = await searchGifs(token, q);
      setResults(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "GIF search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-80 w-80 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_20px_50px_-15px_rgba(0,0,0,0.7)]">
      <div className="flex-none border-b border-white/[0.06] p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#8B93A1]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Tenor"
            className="h-8 w-full rounded-lg border border-[#2A2F3A] bg-[#0F1217]/80 pr-2 pl-8 text-xs text-[#E8EAED] placeholder:text-[#8B93A1]/60 focus:border-[#F0A868]/50 focus:outline-none"
          />
        </div>
      </div>
      <div className="noschat-scroll flex-1 overflow-y-auto p-2">
        {error && (
          <p className="p-2 text-center text-xs text-[#8B93A1]">{error}</p>
        )}
        {!error && loading && results.length === 0 && (
          <p className="p-2 text-center text-xs text-[#8B93A1]">Searching…</p>
        )}
        {!error && !loading && results.length === 0 && (
          <p className="p-2 text-center text-xs text-[#8B93A1]">No GIFs found</p>
        )}
        {!error && (
          <div className="grid grid-cols-2 gap-1.5">
            {results.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => onPick(g.url)}
                title={g.title || "GIF"}
                className="overflow-hidden rounded-lg border border-white/[0.05] transition-opacity hover:opacity-80"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- remote Tenor CDN */}
                <img src={g.preview_url} alt={g.title} className="h-20 w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
