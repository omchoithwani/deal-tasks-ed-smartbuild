import 'dotenv/config';
import {
  getWeekRange,
  getTasksDueThisWeek,
  getAssociatedDealId,
  getDealDetails,
  getAssociatedContact,
  getRelevantNote,
  sleep,
} from './hubspot.js';
import { buildHtml, buildText } from './template.js';
import { sendDigest } from './email.js';

const PROPOSAL_PROPERTY = process.env.HUBSPOT_PROPOSAL_PROPERTY || 'proposal_submission_date';

function dateLabel(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

async function main() {
  const { start, end } = getWeekRange();
  const isCustomRange = !!(process.env.DATE_FROM && process.env.DATE_TO);
  const label = isCustomRange ? `${dateLabel(start)} – ${dateLabel(end)}` : dateLabel(start);
  console.log(`Fetching tasks due week of ${label}...`);

  const tasks = await getTasksDueThisWeek();
  console.log(`Found ${tasks.length} task(s).`);

  const taskRecords = [];

  for (const task of tasks) {
    const taskId = task.id;
    const dealId = await getAssociatedDealId(taskId);

    if (!dealId) {
      console.log(`  Task ${taskId} has no associated deal — skipping.`);
      continue;
    }

    const [dealProps, contactName, notes] = await Promise.all([
      getDealDetails(dealId),
      getAssociatedContact(dealId),
      getRelevantNote(dealId),
    ]);

    console.log(`  Deal: ${dealProps.dealname} (${dealId})`);
    if (notes.latestNote) {
      console.log(`    Latest note date: ${notes.latestNote.date} | by: ${notes.latestNote.addedBy} | preview: ${String(notes.latestNote.body ?? '').slice(0, 80)}`);
    } else {
      console.log(`    Latest note: none`);
    }
    if (notes.edNote) {
      console.log(`    Ed's note date:   ${notes.edNote.date} | by: ${notes.edNote.addedBy} | preview: ${String(notes.edNote.body ?? '').slice(0, 80)}`);
    } else {
      console.log(`    Ed's note: none`);
    }

    taskRecords.push({
      task: {
        subject: task.properties.hs_task_subject,
        status: task.properties.hs_task_status,
        dueDate: task.properties.hs_timestamp,
      },
      deal: {
        dealname: dealProps.dealname,
        contactName,
        companyName: dealProps.account_company_name,
        description: dealProps.description,
        amount: dealProps.amount,
        proposalSubmitted: dealProps[PROPOSAL_PROPERTY],
      },
      notes,
    });

    // Proactive rate-limit buffer: ~6 API calls per task, 300ms gap keeps us
    // well under HubSpot's 100 requests/10s limit.
    await sleep(300);
  }

  if (taskRecords.length === 0) {
    console.log('No deal-associated tasks found. Skipping email.');
    return;
  }

  const subject = `Weekly Task Digest \u2013 Week of ${label}`;
  const html = buildHtml(taskRecords, label);
  const text = buildText(taskRecords, label);

  await sendDigest(subject, html, text);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
