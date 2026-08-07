import type { ButtonAction } from '@/components/table-view/button-actions-editor';
import type { Field } from '@/components/table-view/use-table-data';

/**
 * #156 — prebuilt "When X → do Y" recipes that pre-fill the rule form.
 *
 * The point is a non-technical start: monday.com's recipe library is the gold
 * standard precisely because you pick a sentence, not a trigger + a condition AST
 * + an action list. These fill the SAME form the manual path uses, so a recipe is
 * a starting point you can then edit — never a separate, parallel rule shape.
 *
 * Honesty rule: a recipe that needs a field the database doesn't have returns null
 * from build() and is not offered. Offering "notify the assignee" to a database
 * with no person field would just produce a broken rule.
 */
export interface RecipeFill {
  name: string;
  triggerType: string;
  /** For record_updated: the field to scope the trigger to ('' = any field). */
  triggerFieldId?: string;
  condition?: { field: string; op: string; value?: unknown };
  actions: ButtonAction[];
}

export interface AutomationRecipe {
  id: string;
  /** The "When X → do Y" sentence shown in the gallery. */
  title: string;
  /** One line on what it does / why. */
  description: string;
  /** Returns null when this database can't support the recipe. */
  build: (fields: Field[]) => RecipeFill | null;
}

/** A database's canonical status field: the workflow field, else any single-select. */
function statusField(fields: Field[]): Field | undefined {
  return fields.find((f) => f.type === 'workflow') ?? fields.find((f) => f.type === 'select');
}

/** A person field to notify. */
function personField(fields: Field[]): Field | undefined {
  return fields.find((f) => f.type === 'user');
}

/** The option that most likely means "finished", for the done-style recipes. */
function doneOption(field: Field | undefined): { id: string; label: string } | undefined {
  const opts = field?.options ?? [];
  const done = opts.find((o) => /^(done|complete|completed|closed|shipped|resolved)$/i.test(o.label));
  // Fall back to the LAST option: in a hand-built workflow the terminal state is
  // conventionally last. Never guess when there are no options at all.
  return done ?? opts[opts.length - 1];
}

export const AUTOMATION_RECIPES: AutomationRecipe[] = [
  {
    id: 'status-change-comment',
    title: 'When the status changes → log what changed',
    description: 'Leaves a comment naming the old and new value, so the record carries its own history.',
    build: (fields) => {
      const status = statusField(fields);
      if (!status) return null;
      return {
        name: `When ${status.displayName} changes`,
        triggerType: 'record_updated',
        triggerFieldId: status.id,
        // #273's token renders "Status: Todo → Done".
        actions: [{ type: 'add_comment', body_template: '{changesSummary}' }],
      };
    },
  },
  {
    id: 'done-notify-assignee',
    title: 'When it’s marked done → notify the assignee',
    description: 'The person on the record hears about it without watching the board.',
    build: (fields) => {
      const status = statusField(fields);
      const person = personField(fields);
      const done = doneOption(status);
      if (!status || !person || !done) return null;
      return {
        name: `When ${status.displayName} is ${done.label}`,
        triggerType: 'record_updated',
        triggerFieldId: status.id,
        condition: { field: status.apiName, op: 'has', value: [done.id] },
        actions: [
          { type: 'notify_user', user: person.apiName, message: `“{Title}” is ${done.label}` },
        ],
      };
    },
  },
  {
    id: 'assigned-notify',
    title: 'When someone is assigned → notify them',
    description: 'No more silent hand-offs.',
    build: (fields) => {
      const person = personField(fields);
      if (!person) return null;
      return {
        name: `When ${person.displayName} changes`,
        triggerType: 'record_updated',
        triggerFieldId: person.id,
        actions: [{ type: 'notify_user', user: person.apiName, message: 'You were assigned “{Title}”' }],
      };
    },
  },
  {
    id: 'new-record-kickoff',
    title: 'When a record is created → add a kickoff checklist',
    description: 'Starts every new item with the same first steps.',
    build: () => ({
      name: 'Kickoff checklist on new records',
      triggerType: 'record_created',
      actions: [
        {
          type: 'add_comment',
          body_template: 'Kickoff for “{Title}”:\n- [ ] Confirm the goal\n- [ ] Set a due date\n- [ ] Assign an owner',
        },
      ],
    }),
  },
  {
    id: 'new-record-slack',
    title: 'When a record is created → post it to Slack',
    description: 'Tells the team’s channel, using the workspace Slack connection.',
    build: () => ({
      name: 'Post new records to Slack',
      triggerType: 'record_created',
      actions: [{ type: 'send_slack_message', text: 'New: “{Title}”' }],
    }),
  },
];

/** The recipes this database can actually run, each with its prepared fill. */
export function availableRecipes(
  fields: Field[],
): Array<{ recipe: AutomationRecipe; fill: RecipeFill }> {
  const out: Array<{ recipe: AutomationRecipe; fill: RecipeFill }> = [];
  for (const recipe of AUTOMATION_RECIPES) {
    const fill = recipe.build(fields);
    if (fill) out.push({ recipe, fill });
  }
  return out;
}
