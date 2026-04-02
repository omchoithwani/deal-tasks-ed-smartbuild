import { Resend } from 'resend';

export async function sendDigest(subject, html, text) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Missing env var: RESEND_API_KEY — add it as a GitHub Actions secret named exactly RESEND_API_KEY');
  }
  if (!process.env.FROM_EMAIL) {
    throw new Error('Missing env var: FROM_EMAIL');
  }
  if (!process.env.RECIPIENT_EMAILS) {
    throw new Error('Missing env var: RECIPIENT_EMAILS');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const to = process.env.RECIPIENT_EMAILS.split(',').map((e) => e.trim()).filter(Boolean);

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
