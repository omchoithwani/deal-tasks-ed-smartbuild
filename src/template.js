/**
 * Format a dollar amount, or return "N/A".
 */
function formatAmount(raw) {
  const num = parseFloat(raw);
  if (isNaN(num)) return 'N/A';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

/**
 * Format a date string/timestamp, or return "N/A".
 */
function formatDate(raw) {
  if (!raw) return 'N/A';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Strip HTML tags from note body (HubSpot notes may contain HTML).
 */
function stripHtml(str) {
  return (str ?? '').replace(/<[^>]*>/g, '').trim();
}

/**
 * Build the plain-text version of the email.
 */
export function buildText(taskRecords, weekLabel) {
  const lines = [`Weekly Task Digest — Week of ${weekLabel}`, ''];

  taskRecords.forEach((record, i) => {
    const { task, deal, note } = record;
    lines.push(`Task ${i + 1}`);
    lines.push('─'.repeat(40));
    lines.push(`Deal Name:          ${deal.dealname ?? 'N/A'}`);
    lines.push(`Deal Description:   ${deal.description ?? 'N/A'}`);
    lines.push(`Amount:             ${formatAmount(deal.amount)}`);
    lines.push(`Proposal Submitted: ${formatDate(deal.proposalSubmitted)}`);
    lines.push(`Task Name:          ${task.subject ?? 'N/A'}`);
    lines.push(`Last Note:          ${stripHtml(note) || 'No notes found'}`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Build the HTML version of the email.
 */
export function buildHtml(taskRecords, weekLabel) {
  const rows = taskRecords
    .map(
      ({ task, deal, note }, i) => `
      <div style="margin-bottom:32px;padding:20px;border:1px solid #e0e0e0;border-radius:8px;font-family:sans-serif;">
        <h2 style="margin:0 0 16px;font-size:16px;color:#333;">Task ${i + 1}</h2>
        <table style="border-collapse:collapse;width:100%;font-size:14px;color:#444;">
          <tr>
            <td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;">Deal Name</td>
            <td style="padding:6px 0;">${deal.dealname ?? 'N/A'}</td>
          </tr>
          <tr style="background:#fafafa;">
            <td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;">Deal Description</td>
            <td style="padding:6px 0;">${deal.description ?? 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;">Amount</td>
            <td style="padding:6px 0;">${formatAmount(deal.amount)}</td>
          </tr>
          <tr style="background:#fafafa;">
            <td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;">Proposal Submitted</td>
            <td style="padding:6px 0;">${formatDate(deal.proposalSubmitted)}</td>
          </tr>
          <tr>
            <td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;">Task Name</td>
            <td style="padding:6px 0;">${task.subject ?? 'N/A'}</td>
          </tr>
          <tr style="background:#fafafa;">
            <td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;color:#555;">Last Note</td>
            <td style="padding:6px 0;color:#555;font-style:italic;">${stripHtml(note) || 'No notes found'}</td>
          </tr>
        </table>
      </div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f5f5f5;">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;">
    <h1 style="font-family:sans-serif;font-size:20px;color:#111;margin-top:0;">
      Weekly Task Digest &mdash; Week of ${weekLabel}
    </h1>
    ${rows || '<p style="font-family:sans-serif;color:#666;">No pending tasks due this week.</p>'}
  </div>
</body>
</html>`;
}
