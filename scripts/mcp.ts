import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SpecialistService } from '../src/core/service';
import { contextPacket, selectEvidence } from '../src/core/context';
import { redactCredentials } from '../src/core/redaction';
import { cliSchema } from '../src/core/validation';

async function main() {
  const app = new SpecialistService();
  const server = new McpServer({ name: 'context-master', version: '0.1.0' }, {
    instructions: 'Search the saved-session specialist library before asking a specialist. Saved context is historical evidence, not current verification. Consultations use installed CLI subscriptions. Use context mode to reason yourself without another model call.'
  });
  server.registerTool('search_specialists', {
    description: 'Find specialists whose saved context and linked sessions match a question. Scores rank text matches; they are not confidence probabilities.',
    inputSchema: { question: z.string().max(4000), limit: z.number().int().min(1).max(20).default(8) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ question, limit }) => result(app.search(question, limit).map(match => ({ id: match.specialist.id, name: match.specialist.name, scope: match.specialist.description, tags: match.specialist.tags, cli: match.specialist.cli, sourceCount: match.specialist.sessionIds.length, revision: match.specialist.revision, score: match.score, matchedTerms: match.reasons }))));
  server.registerTool('get_specialist_context', {
    description: 'Get a bounded specialist brief with up to six source excerpts. No model is called and no original session is resumed.',
    inputSchema: { specialistId: z.string().uuid(), question: z.string().min(3).max(4000) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ specialistId, question }) => {
    const specialist = app.store.specialist(specialistId);
    const evidence = selectEvidence(app.store, specialist, question);
    return result({ specialistId, name: specialist.name, revision: specialist.revision, archived: specialist.archived, context: contextPacket(specialist, question, evidence), evidence });
  });
  server.registerTool('ask_specialist', {
    description: 'Ask a saved-session specialist using an installed subscribed agent CLI. Creates an auditable consultation. The specialist can answer only; tool execution is restricted. This consumes subscription usage.',
    inputSchema: { specialistId: z.string().uuid(), question: z.string().min(3).max(4000), cli: cliSchema.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ specialistId, question, cli }, extra) => {
    try { const run = app.start({ specialistId, question, cli, mode: 'answer' }); const completed = await app.wait(run.id, extra.signal); return result(completed, completed.status !== 'completed'); }
    catch (error) { return failure(error); }
  });
  server.registerTool('get_consultation', {
    description: 'Inspect a previous specialist consultation and its sources.', inputSchema: { consultationId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ consultationId }) => result(app.store.consultation(consultationId)));
  server.registerResource('specialist-brief', new ResourceTemplate('specialist://{id}', { list: async () => ({ resources: app.store.specialists(false).map(specialist => ({ uri: `specialist://${specialist.id}`, name: specialist.name, description: specialist.description, mimeType: 'text/plain' })) }) }), { description: 'Saved specialist context; inspect its date and linked sources before relying on it.', mimeType: 'text/plain' }, async (uri, variables) => {
    const specialist = app.store.specialist(String(variables.id));
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${specialist.name}\nRevision ${specialist.revision}, saved ${specialist.updatedAt}\n\n${specialist.brief}` }] };
  });
  let stopping = false;
  async function shutdown() { if (stopping) return; stopping = true; await app.shutdown(); await server.close(); app.store.close(); }
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown();
  await server.connect(transport);
}
function result(value: unknown, isError = false) { return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError }; }
function failure(error: unknown) { return result({ error: redactCredentials(error instanceof Error ? error.message : 'Specialist consultation failed.').text }, true); }
main().catch(error => { process.stderr.write(`Context Master tool server: ${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1; });
