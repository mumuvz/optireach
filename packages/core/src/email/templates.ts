// Transactional email templates. Every dynamic value is HTML-escaped. Each template returns
// subject + HTML + plain-text bodies.
import { escapeHtml } from '@surfaced/shared';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Layout {
  appName: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footnote?: string;
}

function layout({ appName, preheader, heading, paragraphs, action, footnote }: Layout): string {
  const p = paragraphs
    .map((t) => `<p style="margin:0 0 16px;line-height:1.6;color:#334155">${escapeHtml(t)}</p>`)
    .join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(action.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#64748b">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>`
    : '';
  const note = footnote
    ? `<p style="margin:24px 0 0;font-size:13px;color:#64748b">${escapeHtml(footnote)}</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px" cellpadding="0" cellspacing="0"><tr><td>
<p style="margin:0 0 24px;font-weight:700;font-size:18px;color:#0f172a">${escapeHtml(appName)}</p>
<h1 style="margin:0 0 16px;font-size:22px;color:#0f172a">${escapeHtml(heading)}</h1>
${p}${button}${note}
</td></tr></table>
<p style="font-size:12px;color:#94a3b8;margin:16px 0 0">${escapeHtml(appName)} · You received this email because of activity on your account.</p>
</td></tr></table></body></html>`;
}

function plain({ heading, paragraphs, action, footnote }: Omit<Layout, 'appName' | 'preheader'>): string {
  return [
    heading,
    '',
    ...paragraphs,
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    ...(footnote ? ['', footnote] : []),
  ].join('\n');
}

function build(appName: string, subject: string, content: Omit<Layout, 'appName'>): RenderedEmail {
  return { subject, html: layout({ appName, ...content }), text: plain(content) };
}

export interface TemplateData {
  verify_email: { name: string; url: string };
  password_reset: { name: string; url: string };
  workspace_invitation: { inviterName: string; workspaceName: string; role: string; url: string };
  audit_completed: { projectName: string; score: number | null; issues: number; url: string };
  report_ready: { projectName: string; reportTitle: string; url: string };
  subscription_event: { workspaceName: string; headline: string; detail: string; url: string };
  weekly_summary: { name: string; lines: string[]; url: string };
  contact_message: { name: string; email: string; company?: string; topic: string; message: string };
}
export type EmailTemplate = keyof TemplateData;

export function renderEmail<T extends EmailTemplate>(
  template: T,
  data: TemplateData[T],
  appName: string,
): RenderedEmail {
  switch (template) {
    case 'verify_email': {
      const d = data as TemplateData['verify_email'];
      return build(appName, `Confirm your email for ${appName}`, {
        preheader: 'Confirm your email address to finish setting up your account.',
        heading: 'Confirm your email address',
        paragraphs: [
          `Hi ${d.name},`,
          'Please confirm your email address to finish setting up your account. The link expires in 24 hours.',
        ],
        action: { label: 'Confirm email', url: d.url },
        footnote: 'If you did not create an account, you can ignore this email.',
      });
    }
    case 'password_reset': {
      const d = data as TemplateData['password_reset'];
      return build(appName, `Reset your ${appName} password`, {
        preheader: 'Use this link to choose a new password.',
        heading: 'Reset your password',
        paragraphs: [
          `Hi ${d.name},`,
          'We received a request to reset your password. The link expires in 1 hour and can be used once.',
        ],
        action: { label: 'Choose a new password', url: d.url },
        footnote: 'If you did not request this, you can ignore this email — your password will not change.',
      });
    }
    case 'workspace_invitation': {
      const d = data as TemplateData['workspace_invitation'];
      return build(appName, `${d.inviterName} invited you to ${d.workspaceName} on ${appName}`, {
        preheader: `Join ${d.workspaceName} on ${appName}.`,
        heading: `Join ${d.workspaceName}`,
        paragraphs: [
          `${d.inviterName} invited you to join the ${d.workspaceName} workspace as ${d.role}. The invitation expires in 7 days.`,
        ],
        action: { label: 'Accept invitation', url: d.url },
      });
    }
    case 'audit_completed': {
      const d = data as TemplateData['audit_completed'];
      const score = d.score === null ? 'not available' : `${d.score}/100`;
      return build(appName, `Audit completed for ${d.projectName}`, {
        preheader: `Site health index: ${score}.`,
        heading: 'Your website audit is ready',
        paragraphs: [
          `The audit for ${d.projectName} has finished. Site health index: ${score}. Open issues found: ${d.issues}.`,
          'The site health index is a diagnostic score calculated by this application, not a search-engine ranking.',
        ],
        action: { label: 'View audit', url: d.url },
      });
    }
    case 'report_ready': {
      const d = data as TemplateData['report_ready'];
      return build(appName, `Report ready: ${d.reportTitle}`, {
        preheader: `Your report for ${d.projectName} is ready.`,
        heading: 'Your report is ready',
        paragraphs: [`"${d.reportTitle}" for ${d.projectName} has been generated.`],
        action: { label: 'Open report', url: d.url },
      });
    }
    case 'subscription_event': {
      const d = data as TemplateData['subscription_event'];
      return build(appName, `${d.headline} — ${d.workspaceName}`, {
        preheader: d.headline,
        heading: d.headline,
        paragraphs: [d.detail],
        action: { label: 'Manage billing', url: d.url },
      });
    }
    case 'weekly_summary': {
      const d = data as TemplateData['weekly_summary'];
      return build(appName, `Your weekly ${appName} summary`, {
        preheader: 'What changed in your projects this week.',
        heading: 'Weekly summary',
        paragraphs: [`Hi ${d.name}, here is what changed this week:`, ...d.lines],
        action: { label: 'Open dashboard', url: d.url },
        footnote: 'You can turn off weekly summaries in Settings → Notifications.',
      });
    }
    case 'contact_message': {
      const d = data as TemplateData['contact_message'];
      return build(appName, `[Contact] ${d.topic} — ${d.name}`, {
        preheader: `New contact form message from ${d.name}.`,
        heading: 'New contact form message',
        paragraphs: [
          `From: ${d.name} <${d.email}>`,
          `Company: ${d.company ?? '—'}`,
          `Topic: ${d.topic}`,
          d.message,
        ],
      });
    }
    default:
      throw new Error(`Unknown email template: ${String(template)}`);
  }
}
