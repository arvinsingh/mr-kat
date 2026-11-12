import { safe } from './util.js';

// Keep the clickable tag and a readable name after Discord loses the channel.
export function channelLabel(id: string, name?: string | null) {
  return `<#${id}>${name ? ` (${safe(name, 100)})` : ''}`;
}
