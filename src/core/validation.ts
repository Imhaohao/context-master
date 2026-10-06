import { z } from 'zod';
export const sourceSchema = z.enum(['codex', 'claude', 'opencode', 'cursor', 'chatgpt', 'generic']);
export const cliSchema = z.enum(['claude', 'codex', 'opencode', 'cursor']);
export const specialistInput = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(600),
  brief: z.string().trim().min(1).max(12000), tags: z.array(z.string().trim().min(1).max(40)).max(12),
  cli: cliSchema, sessionIds: z.array(z.string().uuid()).min(1).max(30)
});
export const specialistUpdate = specialistInput.extend({ revision: z.number().int().positive() });
export const consultationInput = z.object({
  specialistId: z.string().uuid(), question: z.string().trim().min(3).max(4000),
  mode: z.enum(['answer', 'context']).default('answer'), cli: cliSchema.optional()
});
export const fileInput = z.object({ name: z.string().min(1).max(250), text: z.string().min(1).max(8 * 1024 * 1024) });
export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'AppError'; }
}
