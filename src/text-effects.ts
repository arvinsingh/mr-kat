import { assert } from './util.js';

export const textEffects = [
  'uwuify',
  'emojify',
  'faces',
  'clap',
  'leetspeak',
  'morse',
  'reverse',
  'zalgo',
  'unzalgo',
] as const;
export type TextEffect = (typeof textEffects)[number];
export interface TextOptions {
  density?: number;
  exclamations?: boolean;
  decode?: boolean;
  intensity?: 'low' | 'medium' | 'high';
}

// Original, deliberately small vocabulary. Extend these groups to add more emoji matches.
const emojiGroups: [string, string[]][] = [
  ['happy joy happiness smile smiling cheerful', ['😊', '😄', '😁']],
  ['sad sadness cry crying tears unhappy', ['😢', '😭']],
  ['laugh laughing lol lmao funny hilarious joke jokes', ['😂', '🤣']],
  ['love loved loving heart hearts adore', ['❤️', '❤️', '💕']],
  ['angry mad furious anger', ['😠', '😤']],
  ['cool awesome nice brilliant', ['😎', '✨']],
  ['wow amazing surprised surprise', ['😮', '🤩']],
  ['think thinking thought idea ideas', ['🤔', '💡']],
  ['sleep sleepy sleeping tired bed bedtime', ['😴', '💤']],
  ['hello hi hey wave welcome', ['👋']],
  ['bye goodbye farewell leaving', ['👋']],
  ['thanks thank grateful gratitude', ['🙏']],
  ['yes agree agreed okay ok', ['✅', '👍']],
  ['no nope wrong disagree', ['❌']],
  ['please pray praying hope', ['🙏']],
  ['sorry apology apologies', ['🙇']],
  ['party celebrate celebration birthday', ['🎉', '🥳']],
  ['gift gifts present presents', ['🎁']],
  ['music song songs singing sing', ['🎵', '🎶']],
  ['dance dancing', ['💃', '🕺']],
  ['game games gaming gamer', ['🎮']],
  ['win won winner winning victory', ['🏆']],
  ['lose lost losing loss', ['😔']],
  ['star stars', ['⭐']],
  ['fire hot flames lit', ['🔥']],
  ['water drink drinking thirsty', ['💧']],
  ['rain rainy raining', ['🌧️']],
  ['sun sunny sunshine summer', ['☀️']],
  ['snow snowy winter cold freezing', ['❄️']],
  ['moon night evening', ['🌙']],
  ['morning sunrise', ['🌅']],
  ['cloud clouds cloudy', ['☁️']],
  ['rainbow', ['🌈']],
  ['world earth planet', ['🌍']],
  ['space rocket launch', ['🚀']],
  ['cat cats kitten kittens', ['🐱', '🐈']],
  ['dog dogs puppy puppies', ['🐶', '🐕']],
  ['bird birds', ['🐦']],
  ['fish fishing', ['🐟']],
  ['bear bears', ['🐻']],
  ['rabbit bunny', ['🐰']],
  ['food eat eating hungry meal dinner lunch', ['🍽️']],
  ['pizza', ['🍕']],
  ['burger burgers', ['🍔']],
  ['cake cakes', ['🎂', '🍰']],
  ['cookie cookies biscuit biscuits', ['🍪']],
  ['coffee', ['☕']],
  ['tea chai', ['🍵']],
  ['apple apples', ['🍎']],
  ['banana bananas', ['🍌']],
  ['bread toast', ['🍞']],
  ['rice', ['🍚']],
  ['noodle noodles pasta spaghetti', ['🍜', '🍝']],
  ['chocolate', ['🍫']],
  ['icecream', ['🍦']],
  ['cheese', ['🧀']],
  ['popcorn movie movies cinema film', ['🍿', '🎬']],
  ['book books read reading study studying learn learning', ['📚']],
  ['school class classroom', ['🏫']],
  ['work working job office', ['💼']],
  ['code coding developer programming computer', ['💻']],
  ['bug bugs debugging', ['🐛']],
  ['bot robot robots', ['🤖']],
  ['phone mobile call calling', ['📱']],
  ['message messages chat chatting text texting', ['💬']],
  ['time clock wait waiting', ['⏰']],
  ['fast quick speed running run', ['💨', '🏃']],
  ['slow snail', ['🐌']],
  ['car cars drive driving', ['🚗']],
  ['train trains', ['🚆']],
  ['plane flight fly flying airport travel travelling vacation holiday', ['✈️']],
  ['home house', ['🏠']],
  ['friend friends friendship', ['🤝']],
  ['family', ['🏡']],
  ['team teamwork together', ['🤝']],
  ['strong strength gym workout exercise', ['💪']],
  ['football soccer', ['⚽']],
  ['basketball', ['🏀']],
  ['cricket', ['🏏']],
  ['tennis', ['🎾']],
  ['money cash rich', ['💰']],
  ['shopping shop buy buying', ['🛍️']],
  ['diamond diamonds', ['💎']],
  ['king queen crown royal', ['👑']],
  ['magic magical wizard', ['🪄']],
  ['secret mystery mysterious', ['🤫']],
  ['help support', ['🆘']],
  ['warning danger dangerous caution', ['⚠️']],
  ['rules rule law', ['📜']],
  ['lock locked secure security', ['🔒']],
  ['unlock unlocked', ['🔓']],
  ['key keys', ['🔑']],
  ['check checked complete completed done finish finished', ['✅']],
  ['luck lucky', ['🍀']],
  ['flower flowers garden', ['🌸', '🌻']],
  ['tree trees forest', ['🌳']],
  ['green', ['💚']],
  ['blue', ['💙']],
  ['red', ['❤️']],
  ['purple', ['💜']],
  ['yellow', ['💛']],
  ['orange', ['🧡']],
];
const emojiWords = new Map(
  emojiGroups.flatMap(([words, emojis]) => words.split(' ').map((word) => [word, emojis] as const)),
);
const faces = [':3', 'uwu', 'owo', '^.^', '^-^', '>w<'];
const protectedText =
  /```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s<>]+|www\.[^\s<>]+|<@!?\d+>|<@&\d+>|<#\d+>|<a?:\w+:\d+>|<t:\d+(?::[tTdDfFR])?>/g;
function prose(text: string, change: (part: string) => string): string {
  let output = '',
    offset = 0;
  for (const match of text.matchAll(protectedText)) {
    output += change(text.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  return output + change(text.slice(offset));
}
function random<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
const morse =
  '.- -... -.-. -.. . ..-. --. .... .. .--- -.- .-.. -- -. --- .--. --.- .-. ... - ..- ...- .-- -..- -.-- --.. ----- .---- ..--- ...-- ....- ..... -.... --... ---.. ----.'.split(
    ' ',
  );
const encode = new Map([...alphabet].map((letter, index) => [letter, morse[index]!]));
const decode = new Map([...encode].map(([letter, code]) => [code, letter]));
const leet: Record<string, string> = {
  a: '4',
  b: '8',
  e: '3',
  g: '6',
  i: '1',
  l: '1',
  o: '0',
  s: '5',
  t: '7',
  z: '2',
};
const decorations = [
  '\u030d',
  '\u030e',
  '\u033f',
  '\u0352',
  '\u0357',
  '\u0334',
  '\u0335',
  '\u0336',
  '\u0316',
  '\u0317',
  '\u0318',
  '\u0320',
];
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function transformText(
  effect: TextEffect,
  input: string,
  options: TextOptions = {},
): string {
  assert(textEffects.includes(effect), 'Unknown text effect. Use /help command:text.');
  assert(input.trim().length > 0 && input.length <= 4000, 'Supply 1–4000 characters of text.');
  const density = options.density ?? (effect === 'faces' ? 50 : 100);
  assert(
    Number.isInteger(density) && density >= 1 && density <= 100,
    'Density must be an integer from 1 to 100.',
  );
  let result: string;
  if (effect === 'reverse')
    result = Array.from(graphemes.segment(input), ({ segment }) => segment)
      .reverse()
      .join('');
  else if (effect === 'morse') {
    if (options.decode) {
      assert(
        /^[.\-/\s]+$/.test(input),
        'Morse input may contain dots, dashes, whitespace and / word separators.',
      );
      result = input
        .trim()
        .split(/\s*\/\s*/)
        .map((word) =>
          word
            .trim()
            .split(/\s+/)
            .map((code) => {
              const letter = decode.get(code);
              assert(letter, `Unknown Morse sequence: ${code}`);
              return letter;
            })
            .join(''),
        )
        .join(' ');
    } else {
      assert(
        /^[a-z0-9\s]+$/i.test(input),
        'Morse encoding supports letters A–Z, numbers and spaces. Remove other characters first.',
      );
      result = input
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .map((word) => [...word].map((letter) => encode.get(letter)).join(' '))
        .join(' / ');
    }
  } else
    result = prose(input, (part) => {
      switch (effect) {
        case 'uwuify': {
          let converted = part
            .replace(/[rl]/g, 'w')
            .replace(/[RL]/g, 'W')
            .replace(/n([aeiou])/g, 'ny$1')
            .replace(/N([aeiouAEIOU])/g, 'Ny$1')
            .replace(/ove/g, 'uv');
          if (options.exclamations)
            converted = converted.replace(/[!?]+/g, () => random(['?!', '!!', '!?', '?!?']));
          return converted;
        }
        case 'emojify':
          return part.replace(/\b[A-Za-z]+\b/g, (word) => {
            const emojis = emojiWords.get(word.toLowerCase());
            return emojis && Math.random() * 100 < density ? `${word} ${random(emojis)}` : word;
          });
        case 'faces':
          return part.replace(/\S+/g, (word) =>
            Math.random() * 100 < density ? `${word} ${random(faces)}` : word,
          );
        case 'clap':
          return part.replace(/[^\S\r\n]+/g, '👏');
        case 'leetspeak':
          return part.replace(/[a-z]/gi, (letter) => leet[letter.toLowerCase()] ?? letter);
        case 'unzalgo':
          return part.replace(/[\u0300-\u036f\u0489]/g, '');
        case 'zalgo': {
          const count = { low: 1, medium: 3, high: 5 }[options.intensity ?? 'medium'];
          assert(count, 'Choose low, medium or high Zalgo intensity.');
          return Array.from(graphemes.segment(part), ({ segment }) => {
            if (!/[\p{L}\p{N}]/u.test(segment)) return segment;
            return segment + Array.from({ length: count }, () => random(decorations)).join('');
          }).join('');
        }
      }
    });
  assert(result.trim().length > 0, 'This effect produced no readable text.');
  assert(
    Buffer.byteLength(result, 'utf8') <= 128000,
    'The transformed text is too large. Try a shorter input.',
  );
  return result;
}
