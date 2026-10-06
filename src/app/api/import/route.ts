import { z } from 'zod';
import { handle, readBody } from '@/core/http';
import { service } from '@/core/service';
import { fileInput } from '@/core/validation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handle(request, async () => {
    const input = z.object({ files: z.array(fileInput).min(1).max(20) }).parse(await readBody(request, 20 * 1024 * 1024));
    const store = service().store;
    const results = input.files.map(file => {
      try { return { name: file.name, ...store.import(file.text, file.name), error: null }; }
      catch (error) { return { name: file.name, sessions: [], duplicates: 0, redactions: 0, error: error instanceof Error ? error.message : 'Could not import this file.' }; }
    });
    return { results };
  });
}
