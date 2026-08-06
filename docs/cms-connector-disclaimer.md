# Important Notes for CMS Translation Connectors

*Reusable disclaimer and expectation-setting notes for wxrks CMS connectors. The general section applies to any CMS connector we ship (Webflow, and future platforms); the appendix is Webflow-specific. Use this content in proposals, onboarding, help centers, and client communication.*

---

## The one-paragraph version

A CMS connector automates the translation **loop**: content is scanned, sent to wxrks, translated, and delivered back to the CMS in the right place — no copy-pasting, no spreadsheets. What no connector can automate is **how a website was built**. Structured CMS content is covered almost completely automatically; free-form page content is rich HTML that can be authored in many different ways, and some adjustment between *how content was created* and *what is scannable through the platform's API* is a normal part of every project — not a defect. That's why the person operating the connector needs access to the CMS and a working understanding of how the site is put together.

---

## 1. Two kinds of content, two levels of automation

Every CMS has a spectrum from structured to free-form content, and coverage follows that spectrum:

- **Structured content** (collections, entries, fields — what Webflow literally calls "the CMS"): each piece of text lives in a named field. The connector can enumerate all of it reliably, translate it, and put it back exactly where it belongs. Coverage here is near-total and genuinely automatic.
- **Free-form page content** (designer-built pages): this is rich HTML. The same visual result can be built as plain text elements, reusable components, content pulled from collections, embedded custom code, or even text drawn inside an image. The platform's API exposes *some* of these as translatable text — and that is exactly what the connector scans. The rest is invisible to any API-based tool, no matter the vendor.

**Implication:** "the connector missed something on a page" usually decodes to "that element was built in a home the API doesn't expose (or exposes elsewhere)." The fix is identification and adjustment, not a bug report — though we always want to hear about these cases, because some of them become product improvements.

## 2. What "automatic" means (and doesn't)

- **Automatic:** detecting content, packaging it for translation, creating the wxrks project, and delivering finished translations back into the correct locale — including on a schedule, with no manual steps in between.
- **Not automatic:** knowing that a menu is a component, that a pricing table is an embed, or that a testimonial section is fed by a collection. That knowledge lives in how the site was built, and surfacing it takes a person who can open the site in the CMS's editor.

## 3. What the connector operator needs

Whoever runs a translation project through a connector should have:

1. **Access to the CMS** — the ability to open the site in the platform's editor/designer, not just a URL of the published site. Most "where is this text?" questions are answered in one click inside the editor.
2. **Understanding of the site's construction** — or a direct line to whoever built it. Components, embeds, collection-driven sections, and media text all look identical on the published page and completely different to an API.
3. **Permission to adjust** — projects routinely involve small adjustments: excluding fields that shouldn't be translated, translating a component instead of a page, or handling an out-of-scope element manually.

If the operator is an agency working on a client's site, request editor/designer access during scoping — before committing to word counts or timelines.

## 4. Scoping honestly

Before quoting or promising coverage on a site:

- Browse the site in the CMS editor, not the published site.
- Classify the visible text: structured content / page text / components / embeds / media.
- Run a small pilot (one page, one collection, one component) end-to-end and inspect the result in wxrks before scaling up.

---

## Appendix: Webflow specifics

How the general notes above map onto Webflow:

| Content | Where its text lives | Connector coverage |
|---|---|---|
| **CMS Collections** (what Webflow calls "the CMS") | Collection entry fields | **Fully covered** — all entries, all text fields, minus configured field exclusions |
| **Static pages** | The page's own text elements + component property overrides placed on it | Covered — all text the Webflow API exposes for the page |
| **Components** (navbars, menus, footers, cards) | The component **definition**, not any page | Covered via the Components section; translated once, applied site-wide |
| **HTML embeds / custom code** | Inside the embed's code | **Not scannable** via the API — manual handling |
| **Text inside images/SVGs; image alt text** | Media files / asset settings | **Not scanned** |
| **Link URLs, page SEO title & meta description** | Page/link settings | **Not scanned** today |

Notes specific to Webflow's model:

- **Menus and footers are components** on virtually every Webflow site. Sending the page where a menu appears does not carry the menu's text — the Components section does. This is the single most common "content is missing" question.
- **Webflow Localization must be enabled** and target locales added in the site's Localization settings; the connector can only deliver to locales the site has.
- **Locale spelling matters**: Webflow registers locales as either generic ("French" → `fr`) or regional ("French (France)" → `fr-FR`). The connector uses the site's registered tags; pick the variant that matches your translation-memory setup in wxrks.
- **Inspecting a secondary locale through the API looks "partial" by design** — Webflow only returns nodes that already have a locale-specific override. This is normal and not a sign of missing content.
