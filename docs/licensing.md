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
