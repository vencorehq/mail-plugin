import type { MailAccount, MailFolder, MailMessage } from './types';

export default {
  async setup(vencore: any) {
    console.log('Initializing Vencore Mail Plugin...');

    // 1. Register cron job for delta mail synchronization (runs every 60 seconds)
    vencore.cron.register('*/1 * * * *', 'sync-mail', async () => {
      try {
        await syncAllAccounts(vencore);
      } catch (err) {
        console.error('Mail synchronization cron failed:', err);
      }
    });

    // 2. Register HTTP endpoint to fetch mail body dynamically
    vencore.http.onEndpoint('/fetch-body', async (req: any) => {
      try {
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
        const { accountId, messageId } = payload;

        const body = await fetchMessageBodyFromSource(vencore, accountId, messageId);
        return {
          status: 200,
          body: { success: true, body }
        };
      } catch (err) {
        console.error('Failed to fetch message body:', err);
        return {
          status: 500,
          body: { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
        };
      }
    });

    // 3. Register HTTP endpoint to trigger manual inbox sync
    vencore.http.onEndpoint('/sync-now', async () => {
      try {
        // Automatically recover any accounts previously locked in an error state
        const accounts = (await vencore.table('mail_accounts').list()) as MailAccount[];
        for (const account of accounts) {
          if (account.status === 'error') {
            await vencore.table('mail_accounts').update(account.id, { status: 'active' });
          }
        }

        await syncAllAccounts(vencore);
        return {
          status: 200,
          body: { success: true }
        };
      } catch (err) {
        console.error('Manual sync failed:', err);
        return {
          status: 500,
          body: { success: false, error: String(err) }
        };
      }
    });

    // 4. Register HTTP endpoint to send a new email
    vencore.http.onEndpoint('/send-mail', async (req: any) => {
      try {
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
        const { accountId, to, subject, body } = payload;

        // Fetch account details
        const account = (await vencore.table('mail_accounts').get(accountId)) as MailAccount;
        if (!account) throw new Error('Account not found');

        // Find or create the Sent folder for this account
        const folders = (await vencore.table('mail_folders').list({
          where: { account_id: accountId, type: 'sent' }
        })) as MailFolder[];

        let sentFolderId = '';
        if (folders.length > 0) {
          sentFolderId = folders[0].id;
        } else {
          const folderCreated = await vencore.table('mail_folders').insert({
            account_id: accountId,
            name: 'Sent Messages',
            type: 'sent',
            unread_count: 0,
            total_count: 0
          });
          sentFolderId = folderCreated.id as string;
        }

        const externalId = `sent_${Date.now()}_${accountId}`;

        // Save the full body in key-value plugin storage (not the SQL DB table) to keep relational DB light
        await vencore.storage.set(`body:${externalId}`, `
          <div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
            <p><strong>To:</strong> ${to}</p>
            <p><strong>From:</strong> ${account.email}</p>
            <hr style="border: 0; border-top: 1px solid #eee; margin: 16px 0;" />
            <div style="white-space: pre-wrap;">${body}</div>
          </div>
        `);

        // Insert message header into SQL DB
        await vencore.table('mail_messages').insert({
          account_id: accountId,
          folder_id: sentFolderId,
          external_id: externalId,
          subject: subject,
          sender: account.email,
          recipient: to,
          date: new Date().toISOString(),
          snippet: body.slice(0, 100),
          is_read: true,
          flags: [] // Passed as native JS array for jsonb column
        });

        // Increment total count in the Sent folder
        const folder = await vencore.table('mail_folders').get(sentFolderId) as MailFolder;
        if (folder) {
          await vencore.table('mail_folders').update(sentFolderId, {
            total_count: (folder.total_count || 0) + 1
          });
        }

        return {
          status: 200,
          body: { success: true }
        };
      } catch (err) {
        console.error('Failed to send mail:', err);
        return {
          status: 500,
          body: { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
        };
      }
    });
  }
};

// Synchronize all connected mail accounts
async function syncAllAccounts(vencore: any) {
  const accounts = (await vencore.table('mail_accounts').list()) as MailAccount[];
  
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    
    try {
      await syncAccount(vencore, account);
    } catch (err) {
      console.error(`Failed to sync account: ${account.email}`, err);
      // Log the error but don't lock the account in 'error' state permanently
    }
  }
}

// Synchronize folders and new messages for a single mail account
async function syncAccount(vencore: any, account: MailAccount) {
  // Sync folders list first (Inbox, Sent, Spam, Trash, etc.)
  const folders = await fetchFoldersFromSource(account);
  
  for (const folder of folders) {
    const existingFolders = await vencore.table('mail_folders').list({
      where: { account_id: account.id, name: folder.name }
    });
    
    let folderId = '';
    if (existingFolders.length > 0) {
      folderId = existingFolders[0].id;
      await vencore.table('mail_folders').update(folderId, {
        unread_count: folder.unread_count,
        total_count: folder.total_count
      });
    } else {
      const created = await vencore.table('mail_folders').insert({
        account_id: account.id,
        name: folder.name,
        type: folder.type,
        unread_count: folder.unread_count,
        total_count: folder.total_count
      });
      folderId = created.id as string;
    }
    
    // Fetch and sync new messages in this folder (delta sync)
    const messages = await fetchNewMessagesFromSource(account, folder, folderId);
    for (const msg of messages) {
      // Manual JS/TS check-and-upsert to avoid SQL index constraint warnings
      const existing = await vencore.table('mail_messages').list({
        where: { external_id: msg.external_id }
      }) as MailMessage[];

      if (existing.length > 0) {
        await vencore.table('mail_messages').update(existing[0].id, {
          subject: msg.subject,
          snippet: msg.snippet,
          is_read: msg.is_read,
          flags: msg.flags
        });
      } else {
        await vencore.table('mail_messages').insert({
          account_id: account.id,
          folder_id: folderId,
          external_id: msg.external_id,
          subject: msg.subject,
          sender: msg.sender,
          recipient: msg.recipient,
          date: msg.date,
          snippet: msg.snippet,
          is_read: msg.is_read,
          flags: msg.flags // Passed as native JS array for jsonb column
        });
      }
    }
  }

  // Notify frontend that sync has completed for this account
  vencore.bus.emit('mail:sync_completed', { accountId: account.id });
}

// Mock/Fetch helper to simulate Gmail and IMAP fetching folders
async function fetchFoldersFromSource(account: MailAccount): Promise<Omit<MailFolder, 'id' | 'account_id'>[]> {
  if (account.type === 'gmail') {
    // Simulated Gmail Labels
    return [
      { name: 'INBOX', type: 'inbox', unread_count: 3, total_count: 10 },
      { name: 'SENT', type: 'sent', unread_count: 0, total_count: 5 },
      { name: 'SPAM', type: 'spam', unread_count: 1, total_count: 1 },
      { name: 'TRASH', type: 'trash', unread_count: 0, total_count: 2 }
    ];
  } else {
    // Simulated IMAP Folders
    return [
      { name: 'Inbox', type: 'inbox', unread_count: 5, total_count: 15 },
      { name: 'Sent Messages', type: 'sent', unread_count: 0, total_count: 10 },
      { name: 'Junk E-mail', type: 'spam', unread_count: 2, total_count: 2 },
      { name: 'Deleted Items', type: 'trash', unread_count: 0, total_count: 4 }
    ];
  }
}

// Mock/Fetch helper to simulate pulling headers for new emails
async function fetchNewMessagesFromSource(
  account: MailAccount,
  folder: Omit<MailFolder, 'id' | 'account_id'>,
  folderId: string
): Promise<Omit<MailMessage, 'id' | 'account_id' | 'folder_id'>[]> {
  const nowStr = new Date().toISOString();
  
  if (account.type === 'gmail') {
    if (folder.type === 'inbox') {
      return [
        {
          external_id: `g_msg_1_${account.id}`,
          subject: 'Welcome to Vencore Workspace!',
          sender: 'Vencore onboarding <welcome@vencore.in>',
          recipient: account.email,
          date: nowStr,
          snippet: 'Hi there, welcome to Vencore. This is a white-labeled dashboard...',
          is_read: false,
          flags: ['IMPORTANT']
        },
        {
          external_id: `g_msg_2_${account.id}`,
          subject: 'Weekly CRM Analytics Report',
          sender: 'CRM Automations <reports@vencore.in>',
          recipient: account.email,
          date: new Date(Date.now() - 3600000).toISOString(),
          snippet: 'Your weekly sales pipeline dashboard is ready. Total deals closed: $25K.',
          is_read: true,
          flags: []
        }
      ];
    } else if (folder.type === 'spam') {
      return [
        {
          external_id: `g_msg_3_${account.id}`,
          subject: 'Buy cheap domain name today!',
          sender: 'Spam Sender <info@domainpromo.xyz>',
          recipient: account.email,
          date: nowStr,
          snippet: 'Limited time offer! Buy dot-com domain names for only $1.99...',
          is_read: false,
          flags: []
        }
      ];
    }
  } else {
    // IMAP Mock messages
    if (folder.type === 'inbox') {
      return [
        {
          external_id: `i_msg_1_${account.id}`,
          subject: 'Technical Alert: Server CPU Spike',
          sender: 'Monitor Agent <alerts@vencore.in>',
          recipient: account.email,
          date: nowStr,
          snippet: 'Warning: CPU usage on prod-web-01 reached 89% for 2 consecutive minutes...',
          is_read: false,
          flags: ['alert']
        }
      ];
    }
  }
  
  return [];
}

// Fetch mail message HTML/plain text body on-demand (keeps DB light)
async function fetchMessageBodyFromSource(vencore: any, accountId: string, messageId: string): Promise<string> {
  // Pull message metadata from DB to check type
  const msg = (await vencore.table('mail_messages').get(messageId)) as MailMessage;
  if (!msg) throw new Error('Message not found');

  // Check if this is a custom sent message stored in the key-value storage
  const storedBody = await vencore.storage.get(`body:${msg.external_id}`);
  if (storedBody) return storedBody;

  if (msg.external_id.startsWith('g_msg_1')) {
    return `
      <div style="font-family: sans-serif; padding: 20px; line-height: 1.6; color: #333;">
        <h2 style="color: #2d6a4f; margin-top: 0;">Welcome to Vencore!</h2>
        <p>Dear Customer,</p>
        <p>We are thrilled to welcome you to your new white-labeled workspace platform. Vencore is designed to coordinate your sales, CRM, project management, and server monitoring in one single dashboard.</p>
        <p>Feel free to explore our <strong>Module registry</strong> and install plugins like Zoho CRM, Slack messaging, or custom database connectors.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="font-size: 12px; color: #888;">This is an automated onboarding email sent by Vencore HQ.</p>
      </div>
    `;
  }

  if (msg.external_id.startsWith('g_msg_2')) {
    return `
      <div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
        <h3>Weekly CRM Sales Pipeline Report</h3>
        <p>Hello Team,</p>
        <p>Here is your weekly summary of closed deals:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <thead>
            <tr style="background: #f7f6f2; border-bottom: 1.5px solid #e4e0d8;">
              <th style="padding: 8px; text-align: left;">Deal Name</th>
              <th style="padding: 8px; text-align: right;">Value</th>
              <th style="padding: 8px; text-align: left;">Owner</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom: 1px solid #e4e0d8;">
              <td style="padding: 8px;">Acme Corp Subscription</td>
              <td style="padding: 8px; text-align: right;">$15,000</td>
              <td style="padding: 8px;">Jane Smith</td>
            </tr>
            <tr style="border-bottom: 1px solid #e4e0d8;">
              <td style="padding: 8px;">Beta Group CRM Pilot</td>
              <td style="padding: 8px; text-align: right;">$10,000</td>
              <td style="padding: 8px;">Alex Rivera</td>
            </tr>
          </tbody>
        </table>
        <p>Keep up the great work!</p>
      </div>
    `;
  }

  if (msg.external_id.startsWith('g_msg_3')) {
    return `
      <div style="padding: 16px; font-family: sans-serif; color: #555;">
        <p><strong>SPAM DETECTED:</strong> This message was marked as spam.</p>
        <p>Get dot-com domain names for only $1.99! Limited time promo offer. Click here to claim your deal now.</p>
      </div>
    `;
  }

  return `
    <div style="font-family: sans-serif; padding: 20px;">
      <h4 style="color: #991b1b;">⚠️ System Monitoring Alert</h4>
      <p><strong>Server</strong>: <code>prod-web-01</code> (10.0.0.1)</p>
      <p><strong>Metric Alert</strong>: CPU utilization has exceeded warning threshold (85%). Current load: <strong>89%</strong>.</p>
      <p>Please log in to your Vencore Server Terminal to investigate standard resource utilization.</p>
    </div>
  `;
}
