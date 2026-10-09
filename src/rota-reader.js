// Reads a rota from a photo or PDF (a printed or handwritten rota, a spreadsheet screenshot) with Claude and returns
// each shift on it, matched to the team where it can be. Uses the same ANTHROPIC_API_KEY as the invoice reader;
// ROTA_MODEL overrides the model. Admins review everything before any of it goes onto the (draft) rota.
import Anthropic from '@anthropic-ai/sdk';
import { cleanEnv } from './seed.js';
import { HttpError } from './util.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

export const ROTA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_rota', 'week_starting', 'shifts', 'notes'],
  properties: {
    is_rota: { type: 'boolean', description: 'False if the document is not a staff rota or schedule' },
    week_starting: { type: 'string', description: 'The Monday of the week the rota is for, YYYY-MM-DD, or empty if it doesn’t say' },
    shifts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['person', 'written_as', 'date', 'start_time', 'end_time', 'break_minutes', 'site', 'role', 'notes', 'unsure'],
        properties: {
          person: { type: 'string', description: 'The matching name from the team list, exactly as listed, or empty if nobody on the list matches' },
          written_as: { type: 'string', description: 'The name exactly as written on the rota' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: '24-hour HH:MM' },
          end_time: { type: 'string', description: '24-hour HH:MM' },
          break_minutes: nullable('integer'),
          site: { type: 'string', description: 'The matching site name from the list, exactly as listed, or empty if not shown' },
          role: { type: 'string', description: 'The role or position written for the shift (e.g. Barista, Kitchen), or empty' },
          notes: { type: 'string', description: 'Anything written on the shift itself (e.g. "keys", "training"), or empty' },
          unsure: { type: 'string', description: 'Why this entry might be wrong (e.g. "handwriting unclear – 7 or 1?", "name could be Sam or Sian"), or empty if it is clear' },
        },
      },
    },
    notes: { type: 'string', description: 'Anything the person checking should know (e.g. "Sunday column cut off", "two people share initials"), or empty' },
  },
};

const SYSTEM = `You read staff rotas for a group of UK cafés (photos of printed or handwritten rotas, PDFs, spreadsheet screenshots) so the shifts can be added to their rota system. A manager checks everything you return before it's used.

Return one entry per shift a person is working. Rules:
- Never invent shifts. Skip days marked off, holiday, sick, "-", blank or crossed out.
- person: match the name (or initials / nickname) written to the team list you're given and return the list name exactly. If no one on the list fits, return an empty person and explain in unsure. If two people could fit, choose the likelier and say so in unsure.
- written_as: the name exactly as it appears on the rota.
- date: use the dates given for the week. If the rota shows day names only, map them to that week. UK dates are written day first (03/10 is 3 October).
- Times in 24-hour HH:MM. Read "9-5" as 09:00–17:00 and "7-3" as 07:00–15:00 (café hours: early starts are mornings, end times before the start are afternoon/evening). If only a start is shown with "close" or "til close", use the site's usual closing time if you're told it, otherwise make your best guess and say so in unsure.
- break_minutes: only if a break is written for the shift, otherwise null.
- site: the matching site from the list if the rota shows one (e.g. a heading or column per site), otherwise empty.
- unsure: say plainly when something might be misread; leave empty when it's clear.
- is_rota: false if this isn't a rota.`;

export function rotaReaderFromEnv(env = process.env) {
  const apiKey = cleanEnv(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  const workspace = cleanEnv(env.ANTHROPIC_WORKSPACE_ID);
  const client = new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) });
  return claudeRotaReader({ client, model: cleanEnv(env.ROTA_MODEL) || DEFAULT_MODEL });
}

export function claudeRotaReader({ client, model = DEFAULT_MODEL }) {
  return {
    model,
    /**
     * file: { media_type, data (base64) }; context: { week: [YYYY-MM-DD × 7], team: [{ name, role, site }], sites: [{ name, hours }] }.
     * Returns ROTA_SCHEMA.
     */
    async read({ media_type: mediaType, data }, context) {
      const source = { type: 'base64', media_type: mediaType, data };
      const brief = [
        `The week being planned: ${context.week.map((d) => `${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${d}`).join(', ')}.`,
        `Sites: ${context.sites.map((s) => `${s.name}${s.hours ? ` (usually open ${s.hours})` : ''}`).join('; ')}.`,
        `Team list (name – role – home site):\n${context.team.map((t) => `- ${t.name}${t.role ? ` – ${t.role}` : ''}${t.site ? ` – ${t.site}` : ''}`).join('\n')}`,
        'Read every shift on this rota.',
      ].join('\n\n');
      let response;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 32000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'high', format: { type: 'json_schema', schema: ROTA_SCHEMA } },
          system: SYSTEM,
          messages: [{
            role: 'user',
            content: [mediaType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source }, { type: 'text', text: brief }],
          }],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The Claude API key was refused – check ANTHROPIC_API_KEY');
        if (err instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'The Claude API key isn’t allowed to use this model');
        if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'Claude is busy – try again in a minute');
        if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, `The rota couldn’t be read: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new HttpError(502, `Claude had a problem (${err.status ?? 'network'}) – try again`);
        throw err;
      }
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to read this document');
      if (response.stop_reason === 'max_tokens') throw new HttpError(422, 'This rota is too big to read in one go – try one page or one site at a time');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(502, 'Claude returned something unexpected – try again');
      }
    },
  };
}

/** A stand-in for the demo and tests: "reads" a rota for the week from the team, with a few things to check. */
export function demoRotaReader() {
  return {
    model: 'demo',
    demo: true,
    async read(_file, context) {
      const team = context.team.filter((t) => !/manager/i.test(t.name)).slice(0, 4);
      const [mon, tue, wed, , fri, sat] = context.week;
      const shifts = [];
      team.forEach((t, i) => {
        shifts.push({ person: t.name, written_as: t.name, date: i % 2 ? tue : mon, start_time: i % 2 ? '10:00' : '07:00', end_time: i % 2 ? '16:00' : '15:00', break_minutes: 30, site: t.site ?? '', role: t.role ?? '', notes: '', unsure: '' });
        shifts.push({ person: t.name, written_as: t.name.slice(0, 3), date: i % 2 ? sat : fri, start_time: '08:00', end_time: '14:00', break_minutes: null, site: t.site ?? '', role: t.role ?? '', notes: i === 0 ? 'Opening – keys' : '', unsure: '' });
      });
      if (team[1]) shifts.push({ person: team[1].name, written_as: `${team[1].name[0]}.`, date: wed, start_time: '07:00', end_time: '13:00', break_minutes: null, site: team[1].site ?? '', role: '', notes: '', unsure: `Only the initial “${team[1].name[0]}” is written – best guess` });
      shifts.push({ person: '', written_as: 'Priya', date: sat, start_time: '09:00', end_time: '17:00', break_minutes: 30, site: '', role: 'Barista', notes: '', unsure: 'Nobody called Priya on the team list' });
      return { is_rota: true, week_starting: mon, shifts, notes: 'Demo reading – in the live app Claude reads your uploaded rota.' };
    },
  };
}
