/**
 * What else names a connector (by id: a catalog connector's or a one-click preset's), and the sites where a person
 * uses that service by hand. An agent asked to sign in to one of those sites in its browser suggests the connector
 * first (`browserFirst`, tools/connector-first.ts), and "Meta Business Suite" finds Meta Ads.
 *
 * A site is a host, matched exactly or with `www.`, optionally with the path it starts with
 * (`docs.google.com/spreadsheets`); one that starts with a dot is any host under that domain (`.atlassian.net`).
 */
export const CONNECTOR_NAMES: Record<string, readonly string[]> = {
  "meta-ads": [
    "Facebook Ads",
    "Instagram Ads",
    "Ads Manager",
    "Meta Business",
    "Meta Business Suite",
    "Business Manager",
  ],
  facebook: ["Facebook Pages"],
  x: ["Twitter"],
  "microsoft-teams": ["Teams"],
  youtube: ["YouTube Studio"],
  whatsapp: ["WhatsApp Business"],
};

export const CONNECTOR_SITES: Record<string, readonly string[]> = {
  github: ["github.com"],
  sentry: [".sentry.io"],
  linear: ["linear.app"],
  notion: ["notion.so", "notion.com"],
  drive: ["drive.google.com"],
  "google-docs": ["docs.google.com/document"],
  "google-sheets": ["docs.google.com/spreadsheets", "sheets.google.com"],
  "google-calendar": ["calendar.google.com"],
  onedrive: ["onedrive.live.com"],
  atlassian: [".atlassian.net"],
  slack: [".slack.com"],
  "microsoft-teams": ["teams.microsoft.com", "teams.live.com"],
  asana: ["app.asana.com"],
  stripe: ["dashboard.stripe.com"],
  supabase: ["supabase.com/dashboard"],
  intercom: ["app.intercom.com"],
  zendesk: [".zendesk.com"],
  paypal: ["paypal.com"],
  square: ["app.squareup.com", "squareup.com/dashboard"],
  webflow: ["webflow.com/dashboard"],
  zapier: ["zapier.com/app"],
  canva: ["canva.com"],
  gitlab: ["gitlab.com"],
  neon: ["console.neon.tech"],
  netlify: ["app.netlify.com"],
  vercel: ["vercel.com"],
  railway: ["railway.com"],
  datadog: ["app.datadoghq.com"],
  monday: [".monday.com"],
  clickup: ["app.clickup.com"],
  todoist: ["app.todoist.com"],
  figma: ["figma.com"],
  airtable: ["airtable.com"],
  dropbox: ["dropbox.com"],
  miro: ["miro.com"],
  hubspot: ["app.hubspot.com"],
  salesforce: [".lightning.force.com", ".my.salesforce.com"],
  attio: ["app.attio.com"],
  calendly: ["calendly.com"],
  mixpanel: ["mixpanel.com"],
  amplitude: ["app.amplitude.com"],
  klaviyo: ["klaviyo.com"],
  semrush: ["semrush.com"],
  ahrefs: ["app.ahrefs.com"],
  wix: ["manage.wix.com"],
  contentful: ["app.contentful.com"],
  jotform: ["jotform.com"],
  tally: ["tally.so"],
  "meta-ads": ["adsmanager.facebook.com", "business.facebook.com"],
  facebook: ["facebook.com", "business.facebook.com"],
  instagram: ["instagram.com"],
  linkedin: ["linkedin.com"],
  youtube: ["youtube.com", "studio.youtube.com"],
  pinterest: ["pinterest.com"],
  reddit: ["reddit.com"],
  whatsapp: ["web.whatsapp.com"],
  telegram: ["web.telegram.org"],
  x: ["x.com", "twitter.com"],
  threads: ["threads.com", "threads.net"],
  tiktok: ["tiktok.com"],
};

function matches(site: string, host: string, path: string) {
  const slash = site.indexOf("/");
  const [siteHost, sitePath] = slash < 0 ? [site, ""] : [site.slice(0, slash), site.slice(slash)];
  const hostMatches = siteHost.startsWith(".")
    ? host === siteHost.slice(1) || host.endsWith(siteHost)
    : host === siteHost || host === `www.${siteHost}`;
  return hostMatches && (sitePath === "" || path === sitePath || path.startsWith(`${sitePath}/`));
}

/** The connectors whose service a web address is a page of (`https://business.facebook.com/…`: Meta Ads, Facebook). */
export function connectorsForUrl(raw: string): string[] {
  if (!URL.canParse(raw)) return [];
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") return [];
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return Object.entries(CONNECTOR_SITES)
    .filter(([, sites]) => sites.some((site) => matches(site, host, url.pathname)))
    .map(([id]) => id);
}
