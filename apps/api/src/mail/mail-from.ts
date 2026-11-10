export interface MailSender {
  name: string;
  address: string;
}

/**
 * Parses MAIL_FROM — `Quill from StoryOS <quill@storyos.dev>`, `"Quill" <a@b.c>`
 * or a bare `a@b.c` — into a display name and an address. Returns null when no
 * address can be found (so a caller exposes nothing rather than a guess).
 * Only the sender identity is ever returned; this never touches SMTP config.
 */
export function parseMailFrom(raw: string): MailSender | null {
  const value = raw.trim();
  const angled = /^(.*?)<\s*([^<>\s@]+@[^<>\s@]+)\s*>\s*$/.exec(value);
  if (angled) {
    const name = (angled[1] ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
    return { name, address: angled[2] ?? '' };
  }
  if (/^[^<>\s@]+@[^<>\s@]+$/.test(value)) return { name: '', address: value };
  return null;
}
