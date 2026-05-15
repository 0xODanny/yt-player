import type { SearchResult } from "@/lib/search";

export type SearchSortMode = "relevance" | "newest" | "oldest" | "longest" | "shortest";

export const SEARCH_SORT_MODES: Array<{ value: SearchSortMode; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "longest", label: "Longest" },
  { value: "shortest", label: "Shortest" },
];

export function relevanceScore(query: string, title: string, author?: string): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 0;
  }
  const hayTitle = title.toLowerCase();
  const hayAuthor = (author ?? "").toLowerCase();
  let score = 0;
  if (hayTitle.includes(q)) {
    score += 120;
  }
  if (hayAuthor.includes(q)) {
    score += 100;
  }
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  for (const t of tokens) {
    if (t.length < 2) {
      continue;
    }
    if (hayTitle.includes(t)) {
      score += 45;
    }
    if (hayAuthor.includes(t)) {
      score += 35;
    }
  }
  if (hayTitle.startsWith(q)) {
    score += 18;
  }
  if (hayAuthor.startsWith(q)) {
    score += 14;
  }
  return score;
}

function lengthKey(r: SearchResult): number {
  return typeof r.lengthSeconds === "number" && r.lengthSeconds > 0 ? r.lengthSeconds : 0;
}

function publishedKey(r: SearchResult): number {
  return typeof r.publishedAt === "number" && r.publishedAt > 0 ? r.publishedAt : 0;
}

export function sortSearchResults(
  results: SearchResult[],
  query: string,
  mode: SearchSortMode,
): SearchResult[] {
  const copy = [...results];
  switch (mode) {
    case "relevance":
      return copy.sort((a, b) => {
        const sa = relevanceScore(query, a.title, a.author);
        const sb = relevanceScore(query, b.title, b.author);
        if (sb !== sa) {
          return sb - sa;
        }
        return (b.viewCount ?? 0) - (a.viewCount ?? 0);
      });
    case "newest":
      return copy.sort((a, b) => {
        const pa = publishedKey(a);
        const pb = publishedKey(b);
        if (pb !== pa) {
          return pb - pa;
        }
        return (b.viewCount ?? 0) - (a.viewCount ?? 0);
      });
    case "oldest":
      return copy.sort((a, b) => {
        const pa = publishedKey(a);
        const pb = publishedKey(b);
        if (pa === 0 && pb === 0) {
          return 0;
        }
        if (pa === 0) {
          return 1;
        }
        if (pb === 0) {
          return -1;
        }
        return pa - pb;
      });
    case "longest":
      return copy.sort((a, b) => lengthKey(b) - lengthKey(a));
    case "shortest":
      return copy.sort((a, b) => {
        const la = lengthKey(a);
        const lb = lengthKey(b);
        if (la === 0 && lb === 0) {
          return 0;
        }
        if (la === 0) {
          return 1;
        }
        if (lb === 0) {
          return -1;
        }
        return la - lb;
      });
    default:
      return copy;
  }
}
