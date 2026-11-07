import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topics, manualText } from '../src/manual.js';
import { guides, guideMarkdown } from '../src/guides.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'docs'), { recursive: true });
writeFileSync(
  resolve(root, 'docs/MANUAL.md'),
  `# Complete command manual\n\nGenerated from the registered command definitions and the in-bot help text. Run \`npm run docs\` after changing either.\n\nRead it in Discord with \`/help command:voice setup\` or \`/man command:mod timeout\`. Each entry distinguishes member, moderator and owner access.\n\n${topics.map((topic) => `## /${topic.path}\n\n${manualText(topic)}\n`).join('\n')}\n`,
);
for (const group of Object.keys(guides) as (keyof typeof guides)[])
  writeFileSync(resolve(root, `docs/DISCORD-${group.toUpperCase()}.md`), guideMarkdown(group));
console.info(
  `Generated ${topics.length} manual entries and ${Object.keys(guides).length} Discord-ready guides.`,
);
