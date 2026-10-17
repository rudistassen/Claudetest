// Reads an event enquiry email with Claude and picks out the details – date, times, guests, type of event,
// budget, phone and site – so they can fill in the enquiry. Uses the same ANTHROPIC_API_KEY as the invoice reader.
import Anthropic from '@anthropic-ai/sdk';
import { cleanEnv } from './seed.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

export const ENQUIRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'kind_reason', 'needs_reply', 'title', 'event_type', 'event_date', 'start_time', 'end_time', 'guests', 'budget', 'contact_name', 'phone', 'site'],
  properties: {
    kind: { type: 'string', enum: ['enquiry', 'marketing', 'other'], description: 'enquiry: someone asking about (or arranging) an event; marketing: newsletters, sales pitches, promotions, cold outreach; other: anything else (suppliers, invoices, admin)' },
    kind_reason: { type: 'string', description: 'A few words on why, e.g. "Newsletter from a booking platform"' },
    needs_reply: { type: 'boolean', description: 'Whether the venue still owes the customer a reply' },
    title: { type: 'string', description: 'A short name for the event, e.g. "Sarah’s 40th birthday" or "Acme breakfast meeting"' },
    event_type: { type: 'string' },
    event_date: { type: 'string', description: 'YYYY-MM-DD, or empty' },
    start_time: { type: 'string', description: 'HH:MM (24-hour), or empty' },
    end_time: { type: 'string', description: 'HH:MM (24-hour), or empty' },
    guests: nullable('integer'),
    budget: nullable('number'),
    contact_name: { type: 'string' },
    phone: { type: 'string' },
    site: { type: 'string', description: 'One of the venue names given, exactly as written, or empty' },
  },
};

const EVENT_TYPES = 'Birthday party, Wedding / reception, Corporate, Meeting, Private hire, Christening / baptism, Wake, Baby shower, Christmas party, Other';

const system = (today, sites) => `You read event enquiry emails sent to a group of UK cafés and venues, and pick out the booking details so staff don't have to type them.

Today is ${today}. The emails are the conversation so far, oldest first; each says whether it is from the customer or from the venue. Take only what they say; leave a field empty (or null for numbers) when it isn't stated – never guess.
- kind: "enquiry" if a person is asking about, booking or arranging an event or private hire; "marketing" if it is a newsletter, promotion, sales pitch or cold outreach to the venue (e.g. software, listings, suppliers looking for business); "other" for anything else. Give kind_reason in a few words.
- needs_reply: true if the venue still owes them an answer – the customer's latest email asks something or moves the booking on and the venue hasn't answered it. False if the venue wrote last and nothing new was asked, if the customer's latest email just says thanks, confirms, or says they no longer need it, and for marketing.
- event_date: the date they want, as YYYY-MM-DD. Resolve relative or partial dates ("next Saturday", "14th November") to the next such date on or after today. If they give a range or several options, leave it empty.
- start_time / end_time: 24-hour HH:MM ("7pm" is 19:00). "Until late" or "all day" leaves end_time empty.
- guests: the number of people; for a range ("30-40") use the higher number.
- budget: the total budget in pounds, if they give one.
- event_type: one of ${EVENT_TYPES} – whichever fits best, or empty if it isn't clear.
- title: a short name for the event using their first name or company, e.g. "Sarah's 40th birthday".
- contact_name and phone: the person enquiring, as signed or given in the email.
- site: the venue they're asking about – one of: ${sites.length ? sites.join('; ') : '(none)'} – exactly as written there, or empty if they don't say.`;

// Switched off unless EVENTS_USE_CLAUDE=on is set in Railway → Variables: without it, enquiries still arrive from
// the events inbox, but Claude doesn't read them for their details or sort out marketing emails.
export function enquiryReaderFromEnv(env = process.env) {
  if (cleanEnv(env.EVENTS_USE_CLAUDE)?.toLowerCase() !== 'on') return null;
  const apiKey = cleanEnv(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  const workspace = cleanEnv(env.ANTHROPIC_WORKSPACE_ID);
  const client = new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) });
  return claudeEnquiryReader({ client, model: cleanEnv(env.ENQUIRY_MODEL) || DEFAULT_MODEL });
}

export function claudeEnquiryReader({ client, model = DEFAULT_MODEL }) {
  return {
    model,
    /**
     * emails: [{ direction: 'in' | 'out', from, at, subject, body }] oldest first; sites: the venue names; today: YYYY-MM-DD.
     * Returns the details (ENQUIRY_SCHEMA, blanks as null). Throws on any API problem – the caller carries on without.
     */
    async read({ emails, sites, today }) {
      const text = emails.map((e, i) => `--- Email ${i + 1} · from the ${e.direction === 'out' ? 'venue' : 'customer'}${e.from ? ` (${e.from})` : ''}${e.at ? ` · ${e.at}` : ''} ---\nSubject: ${e.subject ?? ''}\n\n${e.body ?? ''}`).join('\n\n');
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // If the model declines, the request is re-run on Anthropic's recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ENQUIRY_SCHEMA } },
        system: system(today, sites),
        messages: [{ role: 'user', content: `<emails>\n${text}\n</emails>\n\nPick out the event details from these emails.` }],
      });
      if (response.stop_reason === 'refusal') throw new Error('The enquiry reader declined to read this email');
      if (response.stop_reason === 'max_tokens') throw new Error('The email was too long to read');
      const out = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, typeof v === 'string' && !v.trim() ? null : v]));
    },
  };
}
