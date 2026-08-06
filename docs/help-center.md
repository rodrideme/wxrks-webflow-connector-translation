# wxrks Webflow Connector — Help Center

Answers to the most common questions about what the connector translates, where content lives in Webflow, and what to do when something you expected doesn't show up.

---

## What does the connector scan?

The connector reads three kinds of content from your Webflow site, and each kind is translated through its own section of the Translate page:

- **CMS Collections** — every entry of every collection (blog posts, case studies, products…). All text fields are scanned, minus non-text fields and any fields you exclude in Settings → Field exclusions. This is the most fully automated content type: CMS content is structured data, so the connector can read all of it reliably.
- **Static pages** — landing pages, about pages, and any other Designer-built page. The connector scans the page's own text elements (headings, paragraphs, buttons, links' visible text) plus any component property overrides placed on that page.
- **Components** — reusable building blocks (navbars, footers, cards, menus…). The connector translates the component's *definition*, once, and Webflow applies that translation everywhere the component is used across the site.

**Not scanned today:** HTML embeds / custom code blocks, text that is part of an image or SVG file, image alt text, link URLs, and page SEO metadata (title tag / meta description). If a piece of text lives in one of those, it won't arrive in wxrks — see the next question for how to recognize these cases.

---

## I sent a page but some of its text didn't arrive — why?

This is almost always about *how that text was built* in Webflow, not about the page selection. A Webflow page can contain text in five different "homes," and only some of them belong to the page itself:

1. **Plain text elements on the page** → included in the page's work unit. ✅
2. **Components** (navbar, menu, footer, pricing cards…) → the text belongs to the component's definition, **not** the page. Translate it through the **Components** section — once translated, it updates everywhere the component appears. See "How do I translate navigation menus" below.
3. **CMS-driven sections** (a list of posts, testimonials, menu entries stored as CMS items) → the text belongs to the CMS collection. Translate that collection in the Collections section.
4. **HTML embeds / custom code** → not scannable via Webflow's API. These need manual handling.
5. **Images / SVGs containing text, and alt text** → not scanned.

**What to do:** open the page in the Webflow Designer and click the "missing" element. The Designer shows you immediately whether it's a component instance (green outline / component panel), a CMS-bound element, or an embed. That tells you which section of the connector covers it — or whether it's out of scope and needs a manual step.

---

## How do I translate navigation menus, headers, and footers?

In nearly every Webflow site, the navigation bar (including its dropdown menus) and the footer are **Components**. Their text is not part of any individual page — so sending a page, even the page where the menu "lives," will not carry the menu's items.

**What to do:** in Translate's content browser, open the **Components** group and select the navbar / menu / dropdown / footer components, then send them like any other content. The translation is applied to the component definition, so it takes effect on every page at once.

Two related details:

- If a specific placement of a component has **overridden text** (e.g. the same card component with a different title on one page), that override travels with the *page* that contains it — translate the page too.
- If menu entries are generated from a **CMS collection** (common for large "mega menus"), translate that collection in the Collections section.

---

## Why does a static page show no word count (or "0 words")?

Word counts in the content browser are computed for **CMS entries only**. For static pages and components, computing a word count up front would require fully scanning every page of the site just to browse the list, so the connector deliberately skips it — the number you see next to a pages folder is a *page count*, and the words figure for page groups shows as zero/"—".

**A page showing no word count is not empty.** The real, counted word total for a page appears after you send it, on the **Runs** page (per work unit and per run).

---

## Why don't my pages appear in Settings → Field exclusions?

Field exclusions apply to **CMS collection fields** — they let you mark specific fields of a collection (e.g. a SKU or a color code) as not-for-translation. Static pages don't have fields, so they are not listed there. That's by design, not a missing page.

The equivalent control for component text is **Settings → Component property exclusions**, where you can exclude specific component properties (e.g. a width setting or a CSS class stored as text) from translation.

---

## I just created a page and can't see it in the connector

The connector caches the site's page list for up to ~30 minutes to keep browsing fast. A page created moments ago can take up to that long to appear. Come back a little later, or reopen the Translate page.

---

## What are Webflow Components, and why do they matter for translation?

A Component (previously called a "Symbol") is a reusable block a designer creates once and places on many pages — typical examples: the navigation bar, the footer, a call-to-action banner, a pricing card. When the designer edits the component's definition, every page using it updates automatically.

Translation follows the same logic: the connector translates the **definition** once, and the translation propagates to every page where the component is used. This is efficient — a menu translated once covers the whole site — but it also means component text **never appears inside a page's own content**. If you don't know whether an element is a component, open the page in the Webflow Designer and click it: components are clearly marked.

---

## What access do I need to run the connector?

Running a translation project through the connector is not a fully hands-off operation — the operator needs to be able to see and, when necessary, adjust how the site is built:

- **Webflow access to the site being translated** — at minimum the ability to authorize the site for the connector (Sign in with Webflow), and realistically **Designer access**, so you can inspect how content was built (page text vs component vs CMS vs embed) and answer "where does this text live?" questions.
- **Webflow Localization enabled** on the site, with the target locales added in Webflow's Localization settings — the connector can only deliver translations to locales the site actually has.
- **A wxrks account** with credentials (access key/secret) connected in the connector's Settings.

If you are an agency operating on a client's site, ask the client for Designer access (or a seat) before scoping — most "content is missing" questions are resolved in minutes by clicking the element in the Designer.

---

*Something not covered here? Write to support@wxrks.com.*
