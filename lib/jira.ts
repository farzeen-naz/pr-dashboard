const TICKET_RE = /\b([A-Z]{2,10}-\d+)\b/g;

export function extractTickets(title: string, body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of [title, body.slice(0, 2000)]) {
    for (const match of text.matchAll(TICKET_RE)) {
      const id = match[1];
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export function primaryTicket(title: string, body: string): string | null {
  return extractTickets(title, body)[0] ?? null;
}
