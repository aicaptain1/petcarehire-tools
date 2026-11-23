# Tracking jobs-button clicks

## What the site has today (checked November 23, 2026)

petcarehire.com does **not** currently load Google Analytics, Google Tag Manager, or another analytics pixel. The Content-Security-Policy header allows `https://www.googletagmanager.com`, and the cookie banner mentions an “Analytics” category, but no GA/GTM snippet is present in the homepage or /jobs HTML.

So there is no on-site report today that can count calculator-to-jobs clicks. Search Console remains the source for search impressions.

## What the draft links already include

Every jobs button in the widget, and every jobs link in the five state page drafts, carries:

- `ref=salary-tool` (widget) or `ref=salary-page-{state}` (static pages)
- `utm_source=petcarehire`
- `utm_medium=salary_tool` or `utm_medium=salary_page`
- `utm_campaign=salary_calculator` or `utm_campaign=pet-care-salaries-{state}`
- `utm_content={occupation}-{state}` and, on empty-state fallbacks, a `-empty` suffix (for example `31-9096-california-empty`)

Those parameters are harmless if no analytics tool is installed yet, and they will show up automatically once one is.

## Recommended next step (needs your okay; not done)

Add a free Google Analytics 4 property and load it through Job Boardly’s integrations, if it has a GA field, or through a small pathname-agnostic snippet in Custom code (separate from the calculator loader). After that:

- In GA4, Jobs button clicks appear as sessions or page views on `/jobs` with those UTM values, or as a landing-page report filtered to `ref=salary-tool`.
- You can also create a GA4 “click” event later if you want in-page tracking without a page load; the current buttons already navigate to /jobs, so the UTM landing-page report is enough to start.
- Keep Custom code changes in a review step so the Pinterest tag and existing FAQ injector stay intact.

Until GA is installed, the only way to count these clicks is a manual look at server or Job Boardly logs for the `ref=` query, if those logs are available. I have not found a public Job Boardly analytics dashboard on the site itself.
