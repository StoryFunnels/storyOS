# Licensing & dual-licensing policy

StoryOS is **dual-licensed**. (MN-237)

## AGPL-3.0-or-later — for everyone

The StoryOS source is licensed under the **GNU Affero General Public License,
version 3 or later** ([LICENSE](../LICENSE)). It is free for everyone, forever —
run it, self-host it, modify it, redistribute it. The AGPL's one obligation:
**if you run a modified version as a network service, you must offer your users
the modified source.** That reciprocity is deliberate — it keeps the project and
its improvements open. For the overwhelming majority of users (self-hosting a
business, contributing back, building internally) the AGPL is all you need.

## Commercial license — for those who cannot accept the AGPL

Some organizations cannot ship or embed AGPL code — for policy reasons, or
because they want to build a closed derivative without the network-source
obligation. For them, the Project offers a **separate commercial license** (an
exemption from the AGPL's copyleft terms) for a fee.

The core product is **never feature-limited** to force this: the commercial
license changes your *legal terms*, not your *capabilities*. Everything in the
AGPL edition is in the code.

To enquire about a commercial license, contact the maintainer (see the repo's
GitHub profile / README).

## The one exception: the Runner (Apache-2.0)

`packages/runner` (published as `@storyos/runner`) is licensed under the
**Apache License, Version 2.0**. It has its own [LICENSE](../packages/runner/LICENSE)
and NOTICE, `"license": "Apache-2.0"` in its `package.json`, and the server and
everything else in this repository stay AGPL-3.0-or-later. (ADR-0021 section 9.)

Why: the Runner is the program a person installs on their own computer, next to
their own tools, and it is meant to be copied, audited and embedded without
taking on the AGPL's network clause.

The rule that keeps the two licences apart runs one way. Apache code may be used
inside the AGPL work; AGPL code may not be pulled into the Apache package without
making the combination AGPL. So **`packages/runner` must not depend on, import or
copy from any AGPL package in this repository** (`@storyos/schemas`, `sdk`, `mcp`,
`config`, `apps/*`). It defines its own wire types, and its dependencies are
permissive-only (MIT, ISC, BSD, Apache-2.0, 0BSD). This is enforced in CI by
`scripts/check-runner-license-boundary.mjs` (`pnpm license:runner`), which fails
the build on a violation and on anything it cannot tell.

Open questions for the maintainer and counsel (not decided here): the trademark
policy for the name "StoryOS" in forks of the Runner (the Apache licence grants no
trademark rights), and whether contributions to the Runner go through the CLA
below (the current recommendation, so the project keeps the option to relicense) or
inbound-equals-outbound Apache terms.

## Why a CLA is required

Offering a commercial license requires the right to license **all** of the code
under those commercial terms. Any contribution merged without a copyright grant
would be AGPL-only in perpetuity and would foreclose the commercial option for
the affected code. So every contribution must carry the grant in the
[Contributor License Agreement](../CLA.md) — see
[CONTRIBUTING.md](../CONTRIBUTING.md). This protects the *ability* to
dual-license; it does **not** change the AGPL license of the public project, and
contributors keep ownership of their work.

## Third-party dependencies

Dependencies keep their own licenses; CI runs an allow-list scan that fails on
anything incompatible with shipping inside an AGPL-3.0-or-later product, and
emits a CycloneDX SBOM (`scripts/license-check.mjs`).
