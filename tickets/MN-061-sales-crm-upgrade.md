---
id: MN-061
title: Sales CRM pack — Accounts/Contacts/Opportunities/Sales Tasks (agency-crm v2)
status: done
depends_on: [MN-053]
size: M
---

the reference tool `sales-crm`: Account, Opportunity, Sales task, Contact — a real pipeline vs our thin Leads+Proposals.

**New pack `sales-crm`** (agency-crm stays for existing installs, gallery hides it): Accounts 🏢 (Industry select, Size select, Website, Owner user) ↔ Contacts 👤 (Email, Phone, Role text, Primary checkbox) ↔ Opportunities 💰 (Stage select Prospect/Qualified/Proposal/Negotiation/Won/Lost — colored pipeline; Amount currency; Close Date; Probability % number; Next Step text) ↔ Sales Tasks ✅ (Due, Owner, Done).
**Views:** Pipeline board (Opportunities by Stage, card fields Amount+Close), "Closing this month", Accounts table, "My tasks due" (@me).
**Guide:** account→contact→opportunity discipline; every opportunity has a Next Step; pipeline totals per stage arrive with rollups (MN-064).

## Acceptance criteria
- [ ] Pack + samples + views + guide; agency-crm removed from gallery listing (kept installable by slug for compat)
