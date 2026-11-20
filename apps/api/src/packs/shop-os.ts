import { fieldRef, optionRef, sampleDate, sampleRef, SAMPLE_ME } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * ticket #1322 - Shop OS: the pack for a small shop that wants its customers, products, orders and payments in one place, without a spreadsheet.
 * Written from the ticket (Otto's scope: 3-4 databases, a few views, ONE notify-on-status-change automation, ONE starter agent installed
 * switched off, sample data), NOT from the prototype: there is no prototype row for it. The why / can sentences are proposed copy.
 *
 * How it differs from Agency OS (Clients / Contacts / Projects / Tasks) and Deal Desk (Accounts / Deals / Quotes): those are for a business that sells
 * TIME and proposals to other businesses. Shop OS is for a business that sells THINGS to many customers: a price list, an order made of line items,
 * a fulfilment status and a payment status. It is a pack of its own and links to no other pack.
 *
 *   - Four databases: Customers, Products, Orders, Order Lines. An order is its lines: Order Lines links to one Order and one Product.
 *   - Money is USD (edit per shop). A LINE AMOUNT is a formula ({Quantity} * {Unit Price}); an order's TOTAL is a rollup SUM of its line amounts;
 *     a customer's ORDERS PLACED is a rollup COUNT of their orders, leaving out cancelled ones (a rollup cannot sum another rollup, so there is no
 *     "total spent" on the customer). Unit Price is typed on the line (not a lookup of
 *     the product's price) on purpose: the price an order was sold at must not change when the price list does.
 *   - Two state fields on Orders, because "where is it" and "has it been paid" are different questions: Status (fulfilment) and Payment Status. Both
 *     are categorized selects, so a view can say "not paid" or "not cancelled" by CATEGORY and survive a state added later. Every sample order sets BOTH
 *     explicitly: it does not lean on a first-state default.
 *   - Phone is TEXT (there is no phone field type).
 *   - The agent is "Order Update Drafter": on Shipped and on Delivered it drafts the message to the customer as a comment on the order, for a person
 *     to copy and send. StoryOS never sends. Every trigger installs OFF (#1192).
 *   - A formula is created in field order, so Line Amount is declared AFTER Quantity and Unit Price.
 */
const USD = { format: 'currency', currency_code: 'USD', precision: 2 } as const;

/** The order is still live: neither cancelled nor (for a payment) closed out. */
const NOT_CANCELLED = { field: 'status', op: 'category_is_not', value: ['canceled'] };

const AGENT = 'Order Update Drafter';

const AGENT_INSTRUCTIONS =
  'You prepare the message to a customer about their order, as a draft for a person to read and send themselves. You never send anything.\n\n' +
  'WHAT YOU READ\n' +
  '- The order: Status, Payment Status, Payment Method, Ordered On, Delivery Notes, and its Total.\n' +
  '- The customer: Name, Email, Phone.\n' +
  '- The order\'s lines: product, Quantity, Unit Price, Line Amount.\n\n' +
  'WHAT YOU WRITE\n' +
  'One comment on the order, and nothing else, anywhere. The comment starts with a one-line subject, then the message body, then (if anything is missing) ' +
  'a line beginning "Fill in:" that lists each slot a person must complete.\n\n' +
  'WHAT EACH STATUS IS FOR\n' +
  '- Shipped: tell them the order is on its way, list the items and quantities, and say how to reach the shop if something is wrong. Put the carrier and ' +
  'tracking number only if the order\'s Delivery Notes holds them; otherwise leave the slot ⟦TRACKING⟧.\n' +
  '- Delivered: thank them, ask them to say if anything is not right, and nothing more. If Payment Status is Unpaid or Part paid, add ONE polite line ' +
  'saying the order is still open for payment, with the order total and the Payment Method, and leave ⟦AMOUNT DUE⟧ as a slot when the order is Part paid.\n\n' +
  'RULES (they are not optional)\n' +
  '1. You draft. You never send, schedule or queue a message, and you never contact the customer in any way.\n' +
  '2. You never change the order, the customer, a product or a line: not the Status, not the Payment Status, not a price. You change no field of any record.\n' +
  '3. Use only facts that are on the order, the customer and the lines. Never invent a tracking number, a date, a price, a discount, a refund or a delivery ' +
  'promise. A missing detail stays as a visible slot a person fills in, such as ⟦TRACKING⟧.\n' +
  '4. No pressure: no "final reminder", no deadline you were not given, no threat, no late fee. One payment line, once, and it is polite.\n' +
  '5. If the order is Cancelled or Payment Status is Refunded, write nothing and say so in one line.\n' +
  '6. If the customer has no Email and no Phone, say that in one line and write nothing.\n\n' +
  'Keep it short and plain, the way a shop owner writes to one customer.';

export const SHOP_OS_PACK: PackRegistryEntry = {
  slug: 'shop-os',
  name: 'Shop OS',
  summary:
    'Customers, products and orders for a small shop: an order board by status, the orders still unpaid, and a drafter for shipping and delivery messages.',
  highlights: [
    'Customers, Products, Orders and Order Lines, fully linked',
    'An order board: New → Packing → Shipped → Delivered, with Cancelled',
    'Order totals that add up from the line items, and an Unpaid Orders view',
    'An "Order Update Drafter" agent drafts shipping and delivery messages for you to send: gated, your call to run it',
    'Notifies you when an order’s status changes',
  ],
  manifest: {
    format_version: 1,
    license: 'All rights reserved',
    attribution: 'StoryOS',
    slug: 'shop-os',
    name: 'Shop OS',
    version: '1.0.0',
    why: 'You sell products to customers and want every order, and whether it has been paid, in one place.',
    can: [
      'See every order by status, from new to delivered',
      'Spot the orders that have not been paid yet',
      'Get a shipping or delivery message drafted for you to send yourself',
    ],
    scenario: 'pack',
    summary:
      'Customers, products and orders for a small shop: an order board by status, the orders still unpaid, and a drafter for shipping and delivery messages.',
    requires: { connections: [], ai: 'byo' },
    databases: [
      {
        action: 'create',
        name: 'Customers',
        space: 'Shop',
        fields: [
          { name: 'Email', type: 'email' },
          // There is no phone field type: a phone number is text.
          { name: 'Phone', type: 'text' },
          { name: 'City', type: 'text' },
          { name: 'Customer Since', type: 'date' },
          { name: 'Notes', type: 'text', config: { multiline: true } },
        ],
      },
      {
        action: 'create',
        name: 'Products',
        space: 'Shop',
        fields: [
          { name: 'SKU', type: 'text' },
          { name: 'Price', type: 'number', config: { ...USD } },
          { name: 'In Stock', type: 'number' },
          // Edit per shop: these are the sample shop's.
          { name: 'Category', type: 'select', options: [{ label: 'Kitchen' }, { label: 'Home' }, { label: 'Bath' }, { label: 'Gifts' }] },
          { name: 'Active', type: 'checkbox' },
        ],
      },
      {
        action: 'create',
        name: 'Orders',
        space: 'Shop',
        fields: [
          { name: 'Ordered On', type: 'date' },
          { name: 'Payment Method', type: 'select', options: [{ label: 'Card' }, { label: 'Bank transfer' }, { label: 'Cash' }, { label: 'Other' }] },
          { name: 'Paid On', type: 'date' },
          { name: 'Owner', type: 'user' },
          { name: 'Delivery Notes', type: 'text', config: { multiline: true } },
        ],
      },
      {
        action: 'create',
        name: 'Order Lines',
        space: 'Shop',
        fields: [
          { name: 'Quantity', type: 'number' },
          { name: 'Unit Price', type: 'number', config: { ...USD } },
          {
            // Declared after its two inputs (a formula is created in field order).
            name: 'Line Amount',
            type: 'formula',
            config: { expression: '{Quantity} * {Unit Price}', ...USD },
          },
        ],
      },
    ],
    // Orders -> Customers, Order Lines -> Orders and Products. The product is the shop's catalogue entry; the line keeps its own Unit Price.
    relations: [
      { from: 'Orders', to: 'Customers', cardinality: 'one_to_many', from_field: 'Customer', to_field: 'Orders' },
      { from: 'Order Lines', to: 'Orders', cardinality: 'one_to_many', from_field: 'Order', to_field: 'Lines' },
      { from: 'Order Lines', to: 'Products', cardinality: 'one_to_many', from_field: 'Product', to_field: 'Order Lines' },
    ],
    states: [
      {
        // Fulfilment. Red for Cancelled, never gold: gold is the colour of an agent acting.
        database: 'Orders',
        field: 'Status',
        options: [
          { label: 'New', color: 'gray', category: 'backlog' },
          { label: 'Packing', color: 'blue', category: 'started' },
          { label: 'Shipped', color: 'purple', category: 'started' },
          { label: 'Delivered', color: 'green', category: 'completed' },
          { label: 'Cancelled', color: 'red', category: 'canceled' },
        ],
      },
      {
        // Payment, apart from fulfilment: an order can be Delivered and still owed. Refunded is canceled (closed, and not money in).
        database: 'Orders',
        field: 'Payment Status',
        options: [
          { label: 'Unpaid', color: 'orange', category: 'unstarted' },
          { label: 'Part paid', color: 'blue', category: 'started' },
          { label: 'Paid', color: 'green', category: 'completed' },
          { label: 'Refunded', color: 'brown', category: 'canceled' },
        ],
      },
    ],
    agents: [
      {
        name: AGENT,
        goal: 'When an order ships or is delivered, draft the message to the customer as a comment on the order, for a person to send. Never send anything.',
        instructions: AGENT_INSTRUCTIONS,
        scopes: ['read', 'write'],
        approval_policy: ['email', 'outward'],
        target_databases: ['Orders', 'Customers', 'Products', 'Order Lines'],
        // The prompt is not the mechanism: "never changes the order" is held by StoryOS. Every create and update the agent attempts waits in the
        // Approvals inbox (no `database`: all of them); its draft is a COMMENT, which is not a record write.
        write_gates: [{ operations: ['create', 'update'] }],
        skills: [],
        // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered).
        ai_mode: 'your_own_ai',
      },
    ],
    // One trigger per status the agent writes for (a trigger binds ONE option of ONE field). Both install OFF (#1192): nothing is drafted until a
    // person switches the drafter on.
    triggers: [
      { agent: AGENT, database: 'Orders', state_field: 'Status', state_option: 'Shipped', human_gate: false },
      { agent: AGENT, database: 'Orders', state_field: 'Status', state_option: 'Delivered', human_gate: false },
    ],
    derived_fields: [
      {
        // The order's total: a rollup SUM of its lines' Line Amount formula (as Deal Desk's Quote Total). The rollup shows a plain number.
        database: 'Orders',
        name: 'Total',
        type: 'rollup',
        config: { relation_field_id: fieldRef('Orders', 'Lines'), op: 'sum', target_field_api_name: 'line_amount' },
      },
      {
        // How many orders a customer has placed, leaving out cancelled ones (category, not the "Cancelled" option, so a state added later still counts).
        // A COUNT, not a sum of the orders' totals: a rollup will not sum another rollup ("aggregates number fields, not rollup", seen on install).
        database: 'Customers',
        name: 'Orders Placed',
        type: 'rollup',
        config: { relation_field_id: fieldRef('Customers', 'Orders'), op: 'count', filter: NOT_CANCELLED },
      },
    ],
    views: [
      {
        database: 'Orders',
        name: 'Order Board',
        type: 'board',
        default: true,
        config: {
          group_by_field_id: fieldRef('Orders', 'Status'),
          // What a person acts on at a glance. The grouped field is the column, so it is never listed.
          card_field_ids: [fieldRef('Orders', 'Customer'), fieldRef('Orders', 'Total'), fieldRef('Orders', 'Payment Status')],
        },
      },
      {
        // Not paid in full and not cancelled: Unpaid and Part paid (categories unstarted and started), oldest order first. Paid and Refunded are out.
        database: 'Orders',
        name: 'Unpaid Orders',
        type: 'table',
        config: {
          filters: { and: [{ field: 'payment_status', op: 'category_is', value: ['unstarted', 'started'] }, NOT_CANCELLED] },
          sorts: [{ field: 'ordered_on', direction: 'asc' }],
        },
      },
      {
        database: 'Customers',
        name: 'Customers',
        type: 'table',
        default: true,
        config: {},
      },
      {
        database: 'Products',
        name: 'Catalog',
        type: 'table',
        default: true,
        config: { filters: { field: 'active', op: 'eq', value: true } },
      },
    ],
    automations: [
      {
        database: 'Orders',
        name: 'Notify on order status change',
        trigger: { type: 'record_updated', field_id: fieldRef('Orders', 'Status') },
        actions: [{ type: 'notify_user', user: 'owner', message: 'Order status changed: {Name}. Tell the customer, or run the drafter.' }],
        enabled: true,
      },
    ],
    // Invented people and products, each titled "(sample)"; emails use the reserved .example domain. Listed in the order a link needs: a record can
    // only point at one listed before it. Every order sets Status AND Payment Status explicitly.
    sample_records: [
      ...(
        [
          ['Anna Lindqvist', 'anna@lindqvist-home.example', '+00 555 0111', 'Oakfield', -120],
          ['Marcus Webb', 'marcus@webb-family.example', '+00 555 0112', 'Riverside', -60],
          ['Priya Raman', 'priya@raman-studio.example', '+00 555 0113', 'Oakfield', -35],
          ['Tomas Novak', 'tomas@novak-cafe.example', '+00 555 0114', 'Harbourtown', -4],
          ['Hannah Okafor', 'hannah@okafor-books.example', '+00 555 0115', 'Riverside', -20],
        ] as const
      ).map(([name, email, phone, city, since]) => ({
        database: 'Customers',
        values: { name: `${name} (sample)`, email, phone, city, customer_since: sampleDate(since) },
      })),
      ...(
        [
          ['Stoneware mug', 'MUG-01', 24, 'Kitchen', 40],
          ['Linen tea towel', 'TOW-01', 18, 'Kitchen', 65],
          ['Beeswax candle', 'CAN-01', 16, 'Home', 80],
          ['Cedar soap bar', 'SOA-01', 9, 'Bath', 120],
          ['Wool throw', 'THR-01', 85, 'Home', 12],
          ['Gift box', 'BOX-01', 12, 'Gifts', 30],
        ] as const
      ).map(([name, sku, price, category, stock]) => ({
        database: 'Products',
        values: { name: `${name} (sample)`, sku, price, category: optionRef('Products', 'Category', category), in_stock: stock, active: true },
      })),
      ...(
        [
          // [order, customer, status, payment status, payment method, days ago ordered, paid-on days ago or null, delivery notes]
          ['Order 1001', 'Anna Lindqvist', 'Delivered', 'Paid', 'Card', -14, -14, 'Left with the neighbour at number 4'],
          ['Order 1002', 'Marcus Webb', 'Shipped', 'Paid', 'Card', -6, -6, 'Courier, signature not needed'],
          ['Order 1003', 'Priya Raman', 'Packing', 'Unpaid', 'Bank transfer', -3, null, undefined],
          ['Order 1004', 'Tomas Novak', 'New', 'Unpaid', 'Bank transfer', -1, null, 'Café deliveries before 10am'],
          ['Order 1005', 'Hannah Okafor', 'Delivered', 'Part paid', 'Cash', -18, -18, 'Collected in person'],
          ['Order 1006', 'Anna Lindqvist', 'Cancelled', 'Refunded', 'Card', -9, -9, 'Changed her mind before packing'],
        ] as const
      ).map(([name, customer, status, payment, method, ordered, paid, notes]) => ({
        database: 'Orders',
        values: {
          name: `${name} (sample)`,
          customer: [sampleRef('Customers', `${customer} (sample)`)],
          status: optionRef('Orders', 'Status', status),
          payment_status: optionRef('Orders', 'Payment Status', payment),
          payment_method: optionRef('Orders', 'Payment Method', method),
          ordered_on: sampleDate(ordered),
          ...(paid !== null ? { paid_on: sampleDate(paid) } : {}),
          owner: SAMPLE_ME,
          ...(notes !== undefined ? { delivery_notes: notes } : {}),
        },
      })),
      ...(
        [
          // [order, product, quantity, unit price]: the totals the tests check are 66, 85, 66, 40, 120 and 45
          ['Order 1001', 'Stoneware mug', 2, 24],
          ['Order 1001', 'Linen tea towel', 1, 18],
          ['Order 1002', 'Wool throw', 1, 85],
          ['Order 1003', 'Beeswax candle', 3, 16],
          ['Order 1003', 'Cedar soap bar', 2, 9],
          ['Order 1004', 'Gift box', 2, 12],
          ['Order 1004', 'Beeswax candle', 1, 16],
          ['Order 1005', 'Linen tea towel', 4, 18],
          ['Order 1005', 'Stoneware mug', 2, 24],
          ['Order 1006', 'Cedar soap bar', 5, 9],
        ] as const
      ).map(([order, product, quantity, unit]) => ({
        database: 'Order Lines',
        values: {
          name: `${order}: ${product} (sample)`,
          order: [sampleRef('Orders', `${order} (sample)`)],
          product: [sampleRef('Products', `${product} (sample)`)],
          quantity,
          unit_price: unit,
        },
      })),
    ],
    skills: [],
    suggested_sources: [],
  },
};
