import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

const PROPOSAL_PROPERTY = process.env.HUBSPOT_PROPOSAL_PROPERTY || 'proposal_submission_date';
const OWNER_ID = process.env.HUBSPOT_OWNER_ID || '1517615118';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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
 * Returns Monday 00:00:00 UTC and Sunday 23:59:59 UTC for the current week.
 */
export function getWeekRange() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  return { start: monday, end: sunday };
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
              operator: 'EQ',
              value: OWNER_ID,
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
      PROPOSAL_PROPERTY,
    ]),
  );
  return response.properties;
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

  const latest = notes[0];
  const edMatch = notes.find((n) =>
    /ed'?s\s*note/i.test(n.properties.hs_note_body ?? ''),
  );

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
