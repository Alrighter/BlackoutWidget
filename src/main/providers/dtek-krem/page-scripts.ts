export const DTEK_URL = 'https://www.dtek-krem.com.ua/ua/shutdowns';
export const READY_CHECK = "typeof DisconSchedule !== 'undefined' && !!DisconSchedule.fact";

// `DisconSchedule` is a global lexical binding (not on `window`), so it is
// referenced by bare name. Results are JSON-cloned so they survive IPC.
export const READ_FACT =
  'JSON.parse(JSON.stringify({ fact: DisconSchedule.fact, schNames: DisconSchedule.preset.sch_names }))';
export const READ_CITIES = 'Object.keys(DisconSchedule.streets)';

// Stops the page's own background polling so we never add requests to DTEK's.
export const NEUTRALIZE_TIMERS =
  'DisconSchedule.ajax.getStreetsInvisibly = () => {}; DisconSchedule.ajax.checkDisconUpdate = () => {}; true';

/** The page's own background AJAX methods (see NEUTRALIZE_TIMERS); a backstop in case the page kept references to them. */
export const PAGE_POLL_METHODS = ['checkDisconUpdate', 'getStreetsInvisibly'];

/** True for a page-initiated poll: POST /ua/ajax whose form body names one of PAGE_POLL_METHODS. Our getHomeNum passes. */
export function isPagePollRequest(req: { method: string; url: string; body: string | null }): boolean {
  if (req.method.toUpperCase() !== 'POST' || req.body === null) return false;
  try {
    if (new URL(req.url).pathname !== '/ua/ajax') return false;
    return PAGE_POLL_METHODS.includes(new URLSearchParams(req.body).get('method') ?? '');
  } catch {
    return false;
  }
}

export function readStreetsScript(city: string): string {
  return `(DisconSchedule.streets[${JSON.stringify(city)}] || []).slice()`;
}

export function getHomeNumScript(city: string, street: string, updateFact: string): string {
  return `(async () => {
  const params = new URLSearchParams();
  params.append('method', 'getHomeNum');
  const fields = [['city', ${JSON.stringify(city)}], ['street', ${JSON.stringify(street)}], ['updateFact', ${JSON.stringify(updateFact)}]];
  fields.forEach(([name, value], i) => {
    params.append('data[' + i + '][name]', name);
    params.append('data[' + i + '][value]', value);
  });
  const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
  try {
  const res = await fetch('/ua/ajax', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-Token': csrf,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: params.toString(),
    credentials: 'include',
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: '' };
  }
})()`;
}
