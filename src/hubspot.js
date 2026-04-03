import { Client } from '@hubspot/api-client';

const hubspot = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

const PROPOSAL_PROPERTY = process.env.HUBSPOT_PROPOSAL_PROPERTY || 'proposal_submission_date';
const OWNER_ID = process.env.HUBSPOT_OWNER_ID || '1517615118';

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
    const response = await hubspot.crm.objects.searchApi.doSearch('tasks', {
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
    });

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
    const response = await hubspot.crm.associations.v4.basicApi.getPage(
      'tasks',
      taskId,
      'deals',
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
  const response = await hubspot.crm.deals.basicApi.getById(dealId, [
    'dealname',
    'description',
    'amount',
    PROPOSAL_PROPERTY,
  ]);
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
      const page = await hubspot.crm.associations.v4.basicApi.getPage(
        'deals',
        dealId,
        'notes',
        undefined,
        after,
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
    const batchResponse = await hubspot.crm.objects.batchApi.read('notes', {
      inputs: chunk.map((id) => ({ id: String(id) })),
      properties: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'],
    });
    allNotes.push(...(batchResponse.results ?? []));
  }

  const notes = allNotes.sort(
    (a, b) => Number(b.properties.hs_timestamp) - Number(a.properties.hs_timestamp),
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
        const owner = await hubspot.crm.owners.ownersApi.getById(Number(id));
        ownerMap[id] = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email || id;
      } catch {
        ownerMap[id] = id;
      }
    }),
  );

  const noteToObj = (n) => ({
    body: n.properties.hs_note_body ?? null,
    date: n.properties.hs_timestamp ?? null,
    addedBy: ownerMap[n.properties.hubspot_owner_id] ?? null,
  });

  return {
    latestNote: noteToObj(latest),
    edNote: edMatch ? noteToObj(edMatch) : null,
  };
}
