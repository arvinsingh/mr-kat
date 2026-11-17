import { z } from 'zod';
import { id } from './config.js';
import { assert } from './util.js';

const evidence = z.object({
  id,
  channel: id,
  content: z.string(),
  url: z.string(),
  author: id.optional(),
  created: z.number().finite().optional(),
  capturedAt: z.number().finite().optional(),
  attachments: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
});
const request = z.object({
  target: id,
  reason: z.string().refine((value) => value.trim().length > 0),
  expires: z.number().int().positive().optional(),
  originChannel: z.string().min(1).optional(),
  evidence: evidence.optional(),
});
const removalRequest = z.discriminatedUnion('action', [
  request.extend({
    action: z.literal('kick'),
    warningTrigger: z
      .object({
        caseId: z.number().int().positive(),
        ids: z.array(z.number().int().positive()).min(1),
        threshold: z.number().int().positive(),
      })
      .optional(),
  }),
  request.extend({ action: z.literal('ban'), warningTrigger: z.never().optional() }),
]);

export type RemovalRequest = z.infer<typeof removalRequest>;

// Confirmation and approval payloads are persisted JSON, not trusted TypeScript values.
export function parseRemovalRequest(payload: unknown): RemovalRequest {
  const result = removalRequest.safeParse(payload);
  assert(result.success, 'Invalid moderation request. Recreate the request before approving it.');
  return result.data;
}
