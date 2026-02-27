import { z } from 'zod';

const navigateCommandSchema = z.object({
  type: z.literal('navigate'),
  url: z.string().url(),
});

const clickCommandSchema = z.object({
  type: z.literal('click'),
  selector: z.string().min(1),
  waitForNavigation: z.boolean().optional(),
});

const typeCommandSchema = z.object({
  type: z.literal('type'),
  selector: z.string().min(1),
  text: z.string(),
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
});

const selectCommandSchema = z.object({
  type: z.literal('select'),
  selector: z.string().min(1),
  value: z.string(),
});

const waitForCommandSchema = z.object({
  type: z.literal('wait_for'),
  selector: z.string().optional(),
  text: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

const extractCommandSchema = z.object({
  type: z.literal('extract'),
  selector: z.string().min(1),
  kind: z.enum(['text', 'html', 'value', 'attribute', 'console_errors', 'diagnostics']).optional(),
  attribute: z.string().optional(),
});

const screenshotCommandSchema = z.object({
  type: z.literal('screenshot'),
  fullPage: z.boolean().optional(),
});

const tabFocusCommandSchema = z.object({
  type: z.literal('tab_focus'),
  tabId: z.number().int().positive().optional(),
});

const tabOpenCommandSchema = z.object({
  type: z.literal('tab_open'),
  url: z.string().url(),
  active: z.boolean().optional(),
});

const authFillSecretCommandSchema = z.object({
  type: z.literal('auth_fill_secret'),
  selector: z.string().min(1),
  secretKey: z.string().min(1),
  submit: z.boolean().optional(),
});

const evaluateCommandSchema = z.object({
  type: z.literal('evaluate'),
  script: z.string().min(1).max(20_000),
  args: z.array(z.unknown()).max(20).optional(),
});

export const browserCommandSchema = z.discriminatedUnion('type', [
  navigateCommandSchema,
  clickCommandSchema,
  typeCommandSchema,
  selectCommandSchema,
  waitForCommandSchema,
  extractCommandSchema,
  screenshotCommandSchema,
  tabFocusCommandSchema,
  tabOpenCommandSchema,
  authFillSecretCommandSchema,
  evaluateCommandSchema,
]);

export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export type BrowserCommandType = BrowserCommand['type'];

const MUTATING_COMMANDS: ReadonlySet<BrowserCommandType> = new Set([
  'click',
  'type',
  'select',
  'auth_fill_secret',
  'evaluate',
]);

export function isMutatingCommand(command: BrowserCommand): boolean {
  return MUTATING_COMMANDS.has(command.type);
}

export const enqueueCommandRequestSchema = z.object({
  command: browserCommandSchema,
  confirmationToken: z.string().min(8).optional(),
});

export type EnqueueCommandRequest = z.infer<typeof enqueueCommandRequestSchema>;
