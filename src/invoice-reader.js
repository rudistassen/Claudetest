// Reads a supplier invoice (PDF or photo) with Claude and returns its details as structured data.
// Switched on by setting ANTHROPIC_API_KEY (from console.anthropic.com). INVOICE_MODEL overrides the model.
import Anthropic from '@anthropic-ai/sdk';
import { cleanEnv } from './seed.js';
import { HttpError } from './util.js';

const DEFAULT_MODEL = 'claude-opus-5-5';

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// The shape every reading comes back in (structured outputs guarantee it). Text that isn't on the invoice comes
// back empty; only numbers are optional (null), as the API allows at most 16 optional fields in a schema.
export const INVOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_invoice', 'supplier', 'invoice_number', 'invoice_date', 'due_date', 'order_reference', 'currency', 'lines', 'subtotal', 'vat', 'total', 'notes'],
  properties: {
    is_invoice: { type: 'boolean', description: 'False if the document is not a supplier invoice or delivery note with prices' },
    supplier: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'email', 'phone', 'vat_number', 'address'],
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        vat_number: { type: 'string' },
        address: { type: 'string' },
      },
    },
    invoice_number: { type: 'string' },
    invoice_date: { type: 'string', description: 'YYYY-MM-DD, or empty' },
    due_date: { type: 'string', description: 'YYYY-MM-DD, or empty' },
    order_reference: { type: 'string' },
    currency: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'sku', 'quantity', 'unit', 'unit_price', 'line_total', 'vat_rate'],
        properties: {
          description: { type: 'string' },
          sku: { type: 'string' },
          quantity: nullable('number'),
          unit: { type: 'string' },
          unit_price: nullable('number'),
          line_total: nullable('number'),
          vat_rate: nullable('number'),
        },
      },
    },
    subtotal: nullable('number'),
    vat: nullable('number'),
    total: nullable('number'),
    notes: { type: 'string' },
  },
};

const SYSTEM = `You read supplier invoices for a group of UK cafés so their stock system can record what was bought and at what price.

Extract exactly what the document says; never invent values. Use an empty string for text that isn't shown, and null for numbers that aren't shown.
- supplier: the business that issued the invoice (not the café it is addressed to).
- Dates as YYYY-MM-DD (empty if not shown). UK documents write dates day first (03/04/2026 is 3 April 2026).
- lines: one entry per product line, in the order printed. Leave out carriage/delivery charges only if they have no price; include them (as their own line) if they are charged. Include credits and discounts as lines with negative amounts.
- sku: the supplier's product or item code for the line, if printed.
- quantity: the number of units invoiced; unit: the pack or unit it is sold by (e.g. case, each, kg, 4L bottle) if shown.
- unit_price and line_total are before VAT when the invoice shows both; vat_rate is the percentage (20, 5 or 0) when shown per line.
- subtotal (net), vat and total (gross) as printed on the invoice.
- currency: the ISO code, e.g. GBP.
- is_invoice: false if this isn't an invoice, credit note or priced delivery note.
- notes: anything a person checking it should know (e.g. "handwritten amendments", "page 2 appears to be missing"), otherwise empty.`;

// Empty text means "not on the invoice": the rest of BrewView treats that as null.
function blanksToNull(v) {
  if (Array.isArray(v)) return v.map(blanksToNull);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blanksToNull(x)]));
  return typeof v === 'string' && !v.trim() ? null : v;
}

export function invoiceReaderFromEnv(env = process.env) {
  const apiKey = cleanEnv(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  // A key made at organisation level (not inside a workspace) needs to be told which workspace to bill.
  const workspace = cleanEnv(env.ANTHROPIC_WORKSPACE_ID);
  const client = new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) });
  return claudeInvoiceReader({ client, model: cleanEnv(env.INVOICE_MODEL) || DEFAULT_MODEL });
}

export function claudeInvoiceReader({ client, model = DEFAULT_MODEL }) {
  return {
    model,
    /** file: { media_type, data (base64) }. Returns the extracted invoice (INVOICE_SCHEMA). */
    async read({ media_type: mediaType, data }) {
      const source = { type: 'base64', media_type: mediaType, data };
      let response;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          // If the model declines, the request is re-run on Anthropic's recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: INVOICE_SCHEMA } },
          system: SYSTEM,
          messages: [{
            role: 'user',
            content: [
              mediaType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source },
              { type: 'text', text: 'Extract this supplier invoice.' },
            ],
          }],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The invoice reader’s API key was refused – check ANTHROPIC_API_KEY');
        if (err instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'The invoice reader’s API key isn’t allowed to use this model');
        if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'The invoice reader is busy – try again in a minute');
        if (err instanceof Anthropic.BadRequestError && /workspace/i.test(err.message)) {
          throw new HttpError(502, 'The Claude API key isn’t linked to a workspace. In the Anthropic Console, open Workspaces → your workspace → API keys, create a key there and put it in ANTHROPIC_API_KEY (or add ANTHROPIC_WORKSPACE_ID with the workspace’s ID).');
        }
        if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, `The invoice couldn’t be read: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new HttpError(502, `The invoice reader had a problem (${err.status ?? 'network'}) – try again`);
        throw err;
      }
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'The invoice reader declined to read this document');
      if (response.stop_reason === 'max_tokens') throw new HttpError(422, 'This invoice is too long to read in one go – try uploading it a few pages at a time');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return blanksToNull(JSON.parse(text));
      } catch {
        throw new HttpError(502, 'The invoice reader returned something unexpected – try again');
      }
    },
  };
}
