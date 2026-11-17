import { z } from 'zod';
import { id } from './config.js';
import { assert } from './errors.js';

const results = z.object({
  changed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.array(z.string()),
});
const progress = z.object({
  targets: z.array(id).min(1),
  reason: z.string().default(''),
  index: z.number().int().nonnegative().default(0),
  results: results.default(() => ({ changed: 0, skipped: 0, failed: 0, errors: [] })),
});
const roleRequest = progress.extend({ role: id, action: z.enum(['add', 'remove']) });
const nicknameRequest = progress.extend({ template: z.string().min(1) });

export type BatchResults = z.infer<typeof results>;

function parse<T extends z.infer<typeof progress>>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  assert(
    result.success && result.data.index <= result.data.targets.length,
    'Invalid batch request or checkpoint. Recreate the request before running it.',
  );
  return result.data;
}
export const parseBatchRoles = (input: unknown) => parse(roleRequest, input);
export const parseBatchNicknames = (input: unknown) => parse(nicknameRequest, input);
