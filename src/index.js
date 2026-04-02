import 'dotenv/config';
import {
  getWeekRange,
  getTasksDueThisWeek,
  getAssociatedDealId,
  getDealDetails,
  getRelevantNote,
} from './hubspot.js';
import { buildHtml, buildText } from './template.js';
import { sendDigest } from './email.js';

const PROPOSAL_PROPERTY = process.env.HUBSPOT_PROPOSAL_PROPERTY || 'proposal_submission_date';

function weekLabel(start) {
  return start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

async function main() {
  const { start } = getWeekRange();
  const label = weekLabel(start);
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

    const dealProps = await getDealDetails(dealId);
    const notes = await getRelevantNote(dealId);

    taskRecords.push({
      task: {
        subject: task.properties.hs_task_subject,
        status: task.properties.hs_task_status,
        dueDate: task.properties.hs_timestamp,
      },
      deal: {
        dealname: dealProps.dealname,
        description: dealProps.description,
        amount: dealProps.amount,
        proposalSubmitted: dealProps[PROPOSAL_PROPERTY],
      },
      notes,
    });
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
