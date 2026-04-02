import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send the weekly digest email to all configured recipients.
 * @param {string} subject
 * @param {string} html
 * @param {string} text
 */
export async function sendDigest(subject, html, text) {
  const to = process.env.RECIPIENT_EMAILS.split(',').map((e) => e.trim()).filter(Boolean);

  if (to.length === 0) {
    throw new Error('RECIPIENT_EMAILS is empty. Add at least one email address.');
  }

  const { error } = await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Email sent to: ${to.join(', ')}`);
}
