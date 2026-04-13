import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

const PROPOSAL_PROPERTY = process.env.HUBSPOT_PROPOSAL_PROPERTY || 'proposal_submission_date';
const OWNER_IDS = (process.env.HUBSPOT_OWNER_ID || '1517615118').split(',').map((id) => id.trim());

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Retry a HubSpot API call on transient errors (502, 503, 429) with exponential backoff.
 */
async function withRetry(fn, retries = 4, delayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code ?? err.statusCode;
      const transient = [429, 502, 503, 504].includes(code);
      if (!transient || attempt === retries) throw err;
      const wait = delayMs * 2 ** attempt;
      console.warn(`  HubSpot ${code} — retrying in ${wait}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
    }
  }
}

/**
 * Returns the UTC time for midnight (start) or 23:59:59.999 (end) of a date
 * in America/New_York, correctly handling both EST (UTC-5) and EDT (UTC-4).
 */
function easternDayStart(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const easternHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(noon),
  );
  const offsetHours = 12 - easternHour; // 4 for EDT, 5 for EST
  return new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0, 0));
}

function easternDayEnd(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const easternHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(noon),
  );
  const offsetHours = 12 - easternHour;
  return new Date(Date.UTC(year, month - 1, day + 1, offsetHours, 0, 0, 0) - 1);
}

/**
 * Returns the date range to query tasks for in Eastern time.
 * Uses DATE_FROM / DATE_TO env vars if provided, otherwise defaults to the current week.
 */
export function getWeekRange() {
  if (process.env.DATE_FROM && process.env.DATE_TO) {
    return {
      start: easternDayStart(process.env.DATE_FROM),
      end: easternDayEnd(process.env.DATE_TO),
    };
  }

  // Get today's date string in Eastern time (en-CA = YYYY-MM-DD format)
  const todayEastern = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const [y, m, d] = todayEastern.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // day of week (noon UTC = same day Eastern)
  const diffToMonday = (dow === 0 ? -6 : 1 - dow);

  const mondayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(new Date(Date.UTC(y, m - 1, d + diffToMonday + 7, 12)));
  const sundayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(new Date(Date.UTC(y, m - 1, d + diffToMonday + 13, 12)));

  return { start: easternDayStart(mondayStr), end: easternDayEnd(sundayStr) };
}

/**
 * Fetch all open tasks due this week from HubSpot.
 * Uses search API with pagination.
 */
export async function getTasksDueThisWeek() {
  const { start, end } = getWeekRange();
  const tasks = [];
  let after = undefined;

  do {
    const response = await withRetry(() => hubspot.crm.objects.searchApi.doSearch('tasks', {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'hs_task_status',
              operator: 'NOT_IN',
              values: ['COMPLETED', 'DEFERRED'],
            },
            {
              propertyName: 'hs_timestamp',
              operator: 'GTE',
              value: String(start.getTime()),
            },
            {
              propertyName: 'hs_timestamp',
              operator: 'LTE',
              value: String(end.getTime()),
            },
            {
              propertyName: 'hubspot_owner_id',
              operator: 'IN',
              values: OWNER_IDS,
            },
          ],
        },
      ],
      properties: ['hs_task_subject', 'hs_task_status', 'hs_timestamp', 'hs_task_body', 'hubspot_owner_id'],
      limit: 100,
      after,
    }));

    tasks.push(...response.results);
    after = response.paging?.next?.after;
  } while (after);

  return tasks;
}

/**
 * Returns the first associated deal ID for a task, or null if none.
 */
export async function getAssociatedDealId(taskId) {
  try {
    const response = await withRetry(() =>
      hubspot.crm.associations.v4.basicApi.getPage('tasks', taskId, 'deals'),
    );
    const results = response.results ?? [];
    return results.length > 0 ? results[0].toObjectId : null;
  } catch {
    return null;
  }
}

/**
 * Fetch deal properties for a given deal ID.
 */
export async function getDealDetails(dealId) {
  const response = await withRetry(() =>
    hubspot.crm.deals.basicApi.getById(dealId, [
      'dealname',
      'description',
      'amount',
      'account_company_name',
      PROPOSAL_PROPERTY,
    ]),
  );
  return response.properties;
}

/**
 * Returns the name of the first contact associated with a deal, or null.
 */
export async function getAssociatedContact(dealId) {
  try {
    const contactAssoc = await withRetry(() =>
      hubspot.crm.associations.v4.basicApi.getPage('deals', dealId, 'contacts'),
    );
    const contactId = (contactAssoc.results ?? [])[0]?.toObjectId;
    if (!contactId) return null;

    const contact = await withRetry(() =>
      hubspot.crm.contacts.basicApi.getById(contactId, ['firstname', 'lastname']),
    );
    const firstName = contact.properties.firstname ?? '';
    const lastName = contact.properties.lastname ?? '';
    return [firstName, lastName].filter(Boolean).join(' ') || null;
  } catch {
    return null;
  }
}

/**
 * Fetch notes associated with a deal, sorted newest-first.
 * Returns the most recent note that contains "Ed's Note", or the most recent note overall.
 */
export async function getRelevantNote(dealId) {
  // Get ALL note IDs associated with the deal (paginate through associations)
  let noteIds = [];
  let after = undefined;
  try {
    do {
      const page = await withRetry(() =>
        hubspot.crm.associations.v4.basicApi.getPage('deals', dealId, 'notes', after),
      );
      noteIds.push(...(page.results ?? []).map((r) => r.toObjectId));
      after = page.paging?.next?.after;
    } while (after);
  } catch {
    return { latestNote: null, edNote: null };
  }

  if (noteIds.length === 0) return { latestNote: null, edNote: null };

  // Batch-read all notes in chunks of 100 (HubSpot batch API limit)
  const allNotes = [];
  for (let i = 0; i < noteIds.length; i += 100) {
    const chunk = noteIds.slice(i, i + 100);
    const batchResponse = await withRetry(() =>
      hubspot.crm.objects.batchApi.read('notes', {
        inputs: chunk.map((id) => ({ id: String(id) })),
        properties: ['hs_note_body', 'hs_timestamp', 'hs_createdate', 'hubspot_owner_id'],
      }),
    );
    allNotes.push(...(batchResponse.results ?? []));
  }

  // Sort by hs_createdate (actual creation time) — hs_timestamp is user-editable and can be backdated
  const notes = allNotes.sort(
    (a, b) => Number(new Date(b.properties.hs_createdate)) - Number(new Date(a.properties.hs_createdate)),
  );

  if (notes.length === 0) return { latestNote: null, edNote: null };

  const edMatch = notes.find((n) =>
    /ed'?s\s*note/i.test(n.properties.hs_note_body ?? ''),
  );
  const latest = notes.find((n) =>
    !/ed'?s\s*note/i.test(n.properties.hs_note_body ?? ''),
  ) ?? notes[0]; // fallback to most recent if all notes are Ed's notes

  // Fetch owner names for the relevant notes (deduplicated)
  const ownerIds = [...new Set(
    [latest, edMatch].filter(Boolean).map((n) => n.properties.hubspot_owner_id).filter(Boolean),
  )];
  const ownerMap = {};
  await Promise.all(
    ownerIds.map(async (id) => {
      try {
        const owner = await withRetry(() => hubspot.crm.owners.ownersApi.getById(Number(id)));
        ownerMap[id] = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email || id;
      } catch {
        ownerMap[id] = id;
      }
    }),
  );

  const noteToObj = (n) => ({
    body: n.properties.hs_note_body ?? null,
    date: n.properties.hs_createdate ?? null,
    addedBy: ownerMap[n.properties.hubspot_owner_id] ?? null,
  });

  return {
    latestNote: noteToObj(latest),
    edNote: edMatch ? noteToObj(edMatch) : null,
  };
}
