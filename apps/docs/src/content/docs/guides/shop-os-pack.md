---
title: The Shop OS pack
description: What the built-in Shop OS pack creates, its four databases and views, how order totals add up, the status notification, and the Order Update Drafter, which installs switched off and only ever drafts messages for a person to send.
sidebar:
  order: 16
---

**Shop OS** is a built-in Business Pack for a small shop that sells products to many customers and wants its
orders, and whether each one has been paid, in one place. Orders move through a status, an **Order Update Drafter**
agent can prepare the shipping or delivery message, and a person sends it. **StoryOS never sends.** The pack's slug
is `shop-os`. It installs into a space named **Shop** unless you
[choose another space](/mcp/tools/#installing-a-pack-into-an-existing-space), and it declares that it needs your own
AI, for its agent.

## What it creates

Four databases, linked as shown:

| Database | Fields |
|---|---|
| **Customers** | **Email**, **Phone** (text), **City**, **Customer Since**, **Notes**, **Orders** (a link to Orders), **Orders Placed** (a count of their orders, leaving out cancelled ones) |
| **Products** | **SKU**, **Price** (USD), **In Stock**, **Category** (Kitchen, Home, Bath, Gifts: edit these for your shop), **Active** (a checkbox), **Order Lines** (a link) |
| **Orders** | **Customer** (a link to Customers), **Status**, **Payment Status**, **Payment Method** (Card, Bank transfer, Cash, Other), **Ordered On**, **Paid On**, **Owner**, **Delivery Notes**, **Lines** (a link to Order Lines), **Total** |
| **Order Lines** | **Order** (a link to Orders), **Product** (a link to Products), **Quantity**, **Unit Price** (USD), **Line Amount** (a formula) |

An order's **Status** has five options: **New** (backlog), **Packing** and **Shipped** (started), **Delivered**
(completed) and **Cancelled** (canceled). **Payment Status** is a separate field with four: **Unpaid** (unstarted),
**Part paid** (started), **Paid** (completed) and **Refunded** (canceled). They are separate because an order can be
Delivered and still owed. See [Option categories](/guides/pack-manifest/#option-categories).

## How the numbers add up

- **Line Amount** is **Quantity** times **Unit Price**.
- An order's **Total** is the sum of its lines' Line Amount.
- **Unit Price** is typed on the line, not looked up from the product, so the price an order was sold at does not
  change when you change the price list.
- A customer has **Orders Placed**, a count, and no "total spent": a rollup cannot add up another rollup.

Money is in US dollars. Edit the currency on **Price**, **Unit Price** and **Line Amount** for your shop.

## Views

- **Order Board**: a board of orders grouped by Status. Each card shows the customer, the total and the payment status.
- **Unpaid Orders**: orders whose Payment Status is Unpaid or Part paid and whose Status is not Cancelled, oldest
  first. A delivered order that is only part paid is listed. Paid and Refunded orders are not.
- **Customers**: a table of customers.
- **Catalog**: the products ticked Active.

## The automation

**Notify on order status change** is on at install. When an order's **Status** changes, the order's **Owner** is
notified: the cue to tell the customer, or to run the drafter. A change to Payment Status, or to anything else,
does not notify. It counts as one automation run.

## The agent

**Order Update Drafter** runs on your own AI and installs switched off: its two wake switches, one for **Shipped**
and one for **Delivered**, are off until you turn them on in the install review or on the Agent Triggers database.
Nothing is drafted until you do.

It reads the order, the customer and the order's lines, and writes one comment on the order: a shipping message when
the order is Shipped, or a thank-you when it is Delivered, with one polite line about payment if the order is still
Unpaid or Part paid. Its instructions say it:

- never sends, schedules or queues anything, and never contacts the customer;
- changes no field of any record;
- uses only facts on the order, the customer and the lines, leaving a visible slot such as `⟦TRACKING⟧` for anything
  missing, and never inventing a tracking number, date, price, discount or refund;
- uses no pressure: no "final reminder", no deadline, no late fee;
- writes nothing for a Cancelled or Refunded order.
- writes nothing, and says so in one line, when the customer has neither an Email nor a Phone.

The agent's instructions are text a model follows. Two things are enforced by StoryOS instead: every record change
the agent tries waits in the Approvals inbox for a person, and a pack agent's trigger never starts without a person
switching it on.

## Sample data

Five customers, six products, six orders and ten order lines, each titled "(sample)". The orders cover every case a
shop meets: delivered and paid, shipped and paid, packing and unpaid, new and unpaid, delivered and part paid, and
cancelled and refunded. All names and `.example` addresses are invented. **Remove sample data** deletes all 27
records.

## What it does not do

- Send any email or message, take a payment, or send an invoice. It records whether an order is paid; it does not
  charge anyone.
- Run a storefront. It tracks orders you receive, however they arrive.
- Track stock across locations. **In Stock** is a number you keep.
- Add up what a customer has spent.

## How it differs from other packs

It is a pack of its own and links to no other pack. **Agency OS** and **Deal Desk** are for a business that sells
services and proposals to other businesses: clients, projects, accounts, deals and quotes. Shop OS is for a business
that sells products to many customers: a catalogue, orders made of lines, a status and a payment status. Installing
it next to either gives you a separate set of databases.
