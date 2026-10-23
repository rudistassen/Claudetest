// Analyses a week's rota against forecast sales with Claude and suggests where labour could be saved (Rota → Analyse
// this week's rota, admins only). Uses the same ANTHROPIC_API_KEY as the rota and invoice readers; ROTA_MODEL
// overrides the model. Claude only suggests – nothing on the rota changes until a person changes it.
import Anthropic from '@anthropic-ai/sdk';
import { cleanEnv } from './seed.js';
import { HttpError } from './util.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'recommendations', 'watch_outs'],
  properties: {
    headline: { type: 'string', description: 'Two or three plain-English sentences: how the week looks against the forecast and the biggest opportunity' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['site', 'date', 'kind', 'title', 'reason', 'shift_ids', 'new_start_time', 'new_end_time', 'saving', 'confidence'],
        properties: {
          site: { type: 'string', description: 'The site name exactly as given' },
          date: { type: 'string', description: 'YYYY-MM-DD, or empty if it applies to the whole week' },
          kind: { type: 'string', enum: ['cut_shift', 'shorten_shift', 'start_later', 'finish_earlier', 'move_shift', 'cheaper_cover', 'other'] },
          title: { type: 'string', description: 'A short instruction, e.g. "Finish Sam at 14:00 instead of 16:00"' },
          reason: { type: 'string', description: 'Why, in one or two sentences, using the numbers (sales by hour, people on, labour %)' },
          shift_ids: { type: 'array', items: { type: 'integer' }, description: 'The ids of the shifts this is about – only ids from the data' },
          new_start_time: { type: 'string', description: 'For shorten_shift / start_later: the suggested new start (HH:MM), else empty' },
          new_end_time: { type: 'string', description: 'For shorten_shift / finish_earlier: the suggested new finish (HH:MM), else empty' },
          saving: nullable('number'),
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    watch_outs: { type: 'array', items: { type: 'string' }, description: 'Places the rota looks too thin for expected trade, or other risks – short sentences' },
  },
};

const SYSTEM = `You are an experienced operations manager for a group of UK cafés (some also run a bar or theatre café). You review a week's staff rota against forecast sales and recommend practical ways to save labour cost without hurting service.

You are given, for each site: opening hours, the labour target (labour cost as a % of net sales), each day's forecast sales (gross and net; a manager's sales budget replaces the forecast where set), the usual sales and orders for each hour of that weekday from recent weeks, how many people the rota has on in each hour, and every shift with its id, person, role, times, break, cost and whether it's published or a draft change.

How to work:
- Compare people on each hour with that hour's usual sales and orders. Look for over-staffed shoulders (opening and closing hours, mid-afternoon lulls), overlapping shifts of the same role, days whose labour % is well over target, and expensive people covering quiet hours that a cheaper colleague could cover.
- Prefer small, realistic changes: start someone later, finish someone earlier, shorten a long overlap, drop one shift on a quiet day. Never leave a site with nobody on during opening hours, never leave fewer than two people on when sales or orders are busy, and keep opening and closing cover (setting up and cleaning down usually needs someone 30–60 minutes either side of opening hours).
- Respect roles: don't remove the only manager, or the only kitchen person when food is served.
- Only use shift ids that appear in the data. Times are 24-hour HH:MM.
- saving: your estimate in pounds for the change (hours removed × that shift's hourly cost); null if you can't estimate it.
- If the rota already looks lean against the forecast, say so – don't invent savings. Put places that look too thin in watch_outs.
- Order recommendations from the biggest saving to the smallest. Write plainly for a non-technical café owner, in British English.`;

export function rotaAnalystFromEnv(env = process.env) {
  const apiKey = cleanEnv(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  const workspace = cleanEnv(env.ANTHROPIC_WORKSPACE_ID);
  const client = new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) });
  return claudeRotaAnalyst({ client, model: cleanEnv(env.ROTA_MODEL) || DEFAULT_MODEL });
}

export function claudeRotaAnalyst({ client, model = DEFAULT_MODEL }) {
  return {
    model,
    /** week: the rota week's data (see POST /rota/analyse). Returns ANALYSIS_SCHEMA. */
    async analyse(week) {
      let response;
      try {
        // Streamed: a full week across several sites takes a while to think through.
        response = await client.beta.messages.stream({
          model,
          max_tokens: 32000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'high', format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
          system: SYSTEM,
          messages: [{ role: 'user', content: `Here is the rota week to review, as JSON:\n\n${JSON.stringify(week)}\n\nRecommend where labour could be saved.` }],
        }).finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The Claude API key was refused – check ANTHROPIC_API_KEY');
        if (err instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'The Claude API key isn’t allowed to use this model');
        if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'Claude is busy – try again in a minute');
        if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, `The rota couldn’t be analysed: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new HttpError(502, `Claude had a problem (${err.status ?? 'network'}) – try again`);
        throw new HttpError(502, `The rota couldn’t be analysed: ${err.message || 'unknown problem'} – try again`);
      }
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to analyse this rota');
      if (response.stop_reason === 'max_tokens') throw new HttpError(422, 'This rota is too big to analyse in one go – try one site at a time');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(502, 'Claude returned something unexpected – try again');
      }
    },
  };
}

const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * A stand-in for the demo and tests: simple rules instead of Claude. On each day, the shift that starts latest in
 * the afternoon finishes an hour earlier if trade in its last hour is light, and a day well over the labour target
 * is flagged.
 */
export function demoRotaAnalyst() {
  return {
    model: 'demo',
    demo: true,
    async analyse(week) {
      const recommendations = [];
      const watchOuts = [];
      for (const site of week.sites) {
        for (const day of site.days) {
          const shifts = day.shifts.filter((s) => mins(s.end_time) - mins(s.start_time) >= 300);
          const last = shifts.sort((a, b) => mins(b.end_time) - mins(a.end_time))[0];
          if (last && day.people_on_by_hour[Number(last.end_time.slice(0, 2)) - 1] > 1) {
            const end = hhmm(mins(last.end_time) - 60);
            recommendations.push({
              site: site.name, date: day.date, kind: 'finish_earlier', title: `Finish ${last.person} at ${end} instead of ${last.end_time}`,
              reason: `${day.people_on_by_hour[Number(last.end_time.slice(0, 2)) - 1]} people are on in the last hour, when sales are usually light.`,
              shift_ids: [last.id], new_start_time: '', new_end_time: end, saving: null, confidence: 'medium',
            });
          }
          if (day.labour_pct !== null && day.labour_pct > site.labour_target_pct + 10) {
            watchOuts.push(`${site.name} on ${day.weekday}: labour is ${day.labour_pct}% of forecast sales, well over the ${site.labour_target_pct}% target.`);
          }
        }
      }
      return {
        headline: 'Demo analysis – in the live app Claude reviews every shift against your forecast and usual trade by the hour.',
        recommendations: recommendations.slice(0, 6),
        watch_outs: watchOuts.slice(0, 4),
      };
    },
  };
}
