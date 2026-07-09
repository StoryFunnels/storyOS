'use client';

import { useMemo, useState } from 'react';
import { OPTION_COLORS } from '@/components/table-view/cells';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Curated emoji vocabulary (MN-044) — name + keywords power search. */
const EMOJI: Array<[string, string]> = [
  // Work
  ['📌', 'pin'], ['📋', 'clipboard tasks'], ['✅', 'check done tasks'], ['📝', 'note memo'],
  ['📅', 'calendar date'], ['📊', 'chart analytics'], ['📈', 'growth chart'], ['🗂️', 'folders'],
  ['📁', 'folder'], ['🗃️', 'archive records'], ['💼', 'briefcase work'], ['🧭', 'compass strategy'],
  ['🎯', 'target goals'], ['🚀', 'rocket launch release'], ['⚡', 'lightning automation'],
  ['🔥', 'fire hot priority'], ['⭐', 'star favorite'], ['💡', 'idea lightbulb'],
  ['🔔', 'bell notification'], ['🏆', 'trophy win'], ['🧱', 'bricks foundation'],
  // People & comms
  ['🤝', 'handshake clients deal'], ['👥', 'people team members'], ['🗣️', 'speaking voice'],
  ['💬', 'comment chat message'], ['📣', 'megaphone marketing'], ['📢', 'announcement'],
  ['✉️', 'email envelope'], ['📞', 'phone call'], ['🎓', 'education coaching'],
  ['🧑‍💻', 'developer coding'], ['🫶', 'care heart hands'],
  // Objects
  ['📦', 'package deliverable'], ['🔧', 'wrench tools chore'], ['⚙️', 'gear settings'],
  ['🔗', 'link chain relation'], ['🔑', 'key access'], ['🔒', 'lock secure'],
  ['🧲', 'magnet leads'], ['🧪', 'experiment test'], ['🐛', 'bug issue'], ['🛠️', 'hammer wrench build'],
  ['💰', 'money budget sales'], ['💳', 'card payment billing'], ['🧾', 'receipt invoice'],
  ['🖼️', 'picture image design'], ['🎨', 'palette design art'], ['📷', 'camera photo'],
  ['🎬', 'clapper video production'], ['🎥', 'camera video'], ['🎙️', 'microphone podcast'],
  ['📚', 'books library glossary'], ['📖', 'book reading manuscript'], ['📰', 'newspaper articles blog'],
  ['🗞️', 'news press'], ['✏️', 'pencil writing draft'], ['🖋️', 'pen author'],
  // Nature & misc
  ['🌱', 'seedling growth'], ['🌿', 'plant herb'], ['☀️', 'sun day'], ['🌙', 'moon night'],
  ['🌊', 'wave ocean funnel'], ['🍀', 'clover luck'], ['🐝', 'bee busy'], ['🦄', 'unicorn special'],
  ['☕', 'coffee meetings'], ['🍕', 'pizza food'], ['🧊', 'ice cool backlog'],
  ['✈️', 'plane travel'], ['🗺️', 'map roadmap'], ['🏠', 'home house'], ['🏢', 'office company'],
  ['⏰', 'alarm time deadline'], ['⏳', 'hourglass waiting'], ['♻️', 'recycle repeat recurring'],
  ['❤️', 'heart health'], ['🟢', 'green circle active'], ['🟡', 'yellow circle paused'],
  ['🔴', 'red circle blocked'], ['🧠', 'brain knowledge'], ['👁️', 'eye watch review'],
  ['🪄', 'wand magic'], ['🎁', 'gift bonus'], ['🥇', 'gold medal first'],
];

export const COLOR_NAMES = Object.keys(OPTION_COLORS);

/**
 * Icon & color picker (MN-044): emoji search grid + recents + palette row.
 * Databases: color tints the glyph, emoji optional. Spaces: emoji-first.
 */
export function IconColorPicker({
  icon,
  color,
  onChange,
}: {
  icon: string | null;
  color: string | null;
  onChange: (patch: { icon?: string | null; color?: string | null }) => void;
}) {
  const [query, setQuery] = useState('');
  const recents = useMemo<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('storyos-emoji-recents') ?? '[]');
    } catch {
      return [];
    }
  }, []);

  function pickEmoji(char: string) {
    const next = [char, ...recents.filter((c) => c !== char)].slice(0, 12);
    localStorage.setItem('storyos-emoji-recents', JSON.stringify(next));
    onChange({ icon: char });
  }

  const filtered = query.trim()
    ? EMOJI.filter(([, name]) => name.includes(query.trim().toLowerCase()))
    : EMOJI;

  return (
    <div className="flex w-72 flex-col gap-2">
      <Input
        autoFocus
        placeholder="Search icons…"
        className="h-8"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!query && recents.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Recent</p>
          <div className="flex flex-wrap gap-0.5">
            {recents.map((char) => (
              <EmojiButton key={char} char={char} selected={icon === char} onPick={pickEmoji} />
            ))}
          </div>
        </div>
      )}
      <div className="max-h-40 overflow-y-auto">
        <div className="flex flex-wrap gap-0.5">
          {filtered.map(([char]) => (
            <EmojiButton key={char} char={char} selected={icon === char} onPick={pickEmoji} />
          ))}
          {filtered.length === 0 && <p className="p-2 text-[12px] text-muted">No matches.</p>}
        </div>
      </div>
      <div className="border-t border-border-default pt-2">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Color</p>
        <div className="flex gap-1">
          {COLOR_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded hover:bg-hover',
                c === color && 'ring-1 ring-[var(--accent)]',
              )}
              onClick={() => onChange({ color: c === color ? null : c })}
            >
              <span className="h-4 w-4 rounded-full" style={{ backgroundColor: OPTION_COLORS[c] }} />
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="self-start text-[12px] text-muted underline-offset-2 hover:underline"
        onClick={() => onChange({ icon: null, color: null })}
      >
        Remove icon & color
      </button>
    </div>
  );
}

function EmojiButton({
  char,
  selected,
  onPick,
}: {
  char: string;
  selected: boolean;
  onPick: (char: string) => void;
}) {
  return (
    <button
      type="button"
      className={cn('rounded p-1 text-[16px] leading-none hover:bg-hover', selected && 'bg-accent-soft')}
      onClick={() => onPick(char)}
    >
      {char}
    </button>
  );
}

/** Sidebar/database glyph: emoji if set, else the stacked-disk glyph tinted by color. */
export function EntityIcon({
  icon,
  color,
  fallback,
  className,
}: {
  icon?: string | null;
  color?: string | null;
  fallback: React.ReactNode;
  className?: string;
}) {
  if (icon) {
    return (
      <span className={cn('inline-flex w-4 shrink-0 items-center justify-center text-[14px] leading-none', className)}>
        {icon}
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex shrink-0 items-center', className)}
      style={color ? { color: OPTION_COLORS[color] } : undefined}
    >
      {fallback}
    </span>
  );
}
