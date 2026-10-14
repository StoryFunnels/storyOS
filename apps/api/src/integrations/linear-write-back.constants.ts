/**
 * What a pushed comment's first line looks like: "**<author> · via StoryOS**". Kept in its own file so the importer and
 * the write-back service share ONE definition without importing each other (#907).
 */
export const VIA_STORYOS_PATTERN = /^\*{0,2}.{1,200} · via StoryOS\*{0,2}\s*$/m;
