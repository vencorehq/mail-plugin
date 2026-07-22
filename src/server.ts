import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { MailAccount, MailFolder, MailMessage } from './types';

export default {
  async setup(vencore: any) {
    console.log('Initializing Vencore Mail Plugin v2 (Real IMAP & SMTP Enabled)...');

    // 1. Register cron job for delta mail synchronization (runs every 60 seconds)
    vencore.cron.register('*/1 * * * *', 'sync-mail', async () => {
      try {
        await syncAllAccounts(vencore);
      } catch (err) {
        console.error('Mail synchronization cron failed:', err);
      }
    });

    // 2. Register HTTP endpoint to fetch mail body dynamically (on-demand IMAP stream)
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

    // 4. Register HTTP endpoint to send or reply/forward a new email (SMTP)
    vencore.http.onEndpoint('/send-mail', async (req: any) => {
      try {
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
        const { accountId, to, subject, body } = payload;

        // Fetch account details
        const account = (await vencore.table('mail_accounts').get(accountId)) as MailAccount;
        if (!account) throw new Error('Account not found');

        // Send real email via SMTP
        await sendOutgoingEmail(account, to, subject, body);

        // Find or create the Sent folder for this account in local DB
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

        // Save full body in key-value plugin storage (JSON stringified to satisfy jsonb value column constraint)
        await vencore.storage.set(`body:${externalId}`, JSON.stringify(`
          <div style="font-family: sans-serif; padding: 20px; line-height: 1.6; color: #111111; background: #ffffff;">
            <div style="white-space: pre-wrap;">${body}</div>
          </div>
        `));

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
          flags: JSON.stringify([]) // Stringified JSON representation for jsonb column
        });

        // Increment total count in Sent folder
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

    // 5. Register HTTP endpoint to toggle message star/flag status
    vencore.http.onEndpoint('/toggle-star', async (req: any) => {
      try {
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
        const { messageId } = payload;

        const msg = (await vencore.table('mail_messages').get(messageId)) as MailMessage;
        if (!msg) throw new Error('Message not found');

        // Parse flags properly if stringified in database
        const rawFlags = msg.flags;
        const currentFlags: string[] = typeof rawFlags === 'string'
          ? JSON.parse(rawFlags)
          : Array.isArray(rawFlags) ? rawFlags : [];

        const isStarred = currentFlags.includes('STARRED');
        const nextFlags = isStarred
          ? currentFlags.filter(f => f !== 'STARRED')
          : [...currentFlags, 'STARRED'];

        await vencore.table('mail_messages').update(messageId, {
          flags: JSON.stringify(nextFlags) // Stringified JSON representation
        });

        return {
          status: 200,
          body: { success: true, isStarred: !isStarred }
        };
      } catch (err) {
        return {
          status: 500,
          body: { success: false, error: String(err) }
        };
      }
    });

    // 6. Register HTTP endpoint to delete or move message to Trash
    vencore.http.onEndpoint('/delete-message', async (req: any) => {
      try {
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
        const { messageId, accountId } = payload;

        const msg = (await vencore.table('mail_messages').get(messageId)) as MailMessage;
        if (!msg) throw new Error('Message not found');

        const currentFolder = (await vencore.table('mail_folders').get(msg.folder_id)) as MailFolder;
        
        // If already in trash, permanently delete from DB
        if (currentFolder && currentFolder.type === 'trash') {
          await vencore.table('mail_messages').delete(messageId);
          return { status: 200, body: { success: true, action: 'purged' } };
        }

        // Otherwise, move to Trash folder
        const trashFolders = (await vencore.table('mail_folders').list({
          where: { account_id: accountId, type: 'trash' }
        })) as MailFolder[];

        let trashFolderId = '';
        if (trashFolders.length > 0) {
          trashFolderId = trashFolders[0].id;
        } else {
          const created = await vencore.table('mail_folders').insert({
            account_id: accountId,
            name: 'Trash',
            type: 'trash',
            unread_count: 0,
            total_count: 0
          });
          trashFolderId = created.id as string;
        }

        await vencore.table('mail_messages').update(messageId, {
          folder_id: trashFolderId
        });

        return { status: 200, body: { success: true, action: 'moved_to_trash' } };
      } catch (err) {
        return { status: 500, body: { success: false, error: String(err) } };
      }
    });

    // 7. Register HTTP endpoint to disconnect/delete an email account
    vencore.http.onEndpoint('/delete-account', async (req: any) => {
      try {
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
        const { accountId } = payload;

        // Delete all messages
        const msgs = (await vencore.table('mail_messages').list({ where: { account_id: accountId } })) as MailMessage[];
        for (const m of msgs) {
          await vencore.table('mail_messages').delete(m.id);
        }

        // Delete all folders
        const fds = (await vencore.table('mail_folders').list({ where: { account_id: accountId } })) as MailFolder[];
        for (const f of fds) {
          await vencore.table('mail_folders').delete(f.id);
        }

        // Delete account
        await vencore.table('mail_accounts').delete(accountId);

        return { status: 200, body: { success: true } };
      } catch (err) {
        return { status: 500, body: { success: false, error: String(err) } };
      }
    });
  }
};

// Auto-resolves SMTP hostname from IMAP settings
function getSmtpConfig(account: MailAccount) {
  const creds = account.credentials;

  if (account.type === 'gmail') {
    return {
      service: 'gmail',
      auth: {
        user: account.email,
        pass: creds.password
      }
    };
  }

  // Swap imap.host to smtp.host
  const imapHost = creds.host || '';
  let smtpHost = imapHost;
  if (imapHost.startsWith('imap.')) {
    smtpHost = imapHost.replace(/^imap\./, 'smtp.');
  } else if (imapHost.startsWith('mail.')) {
    smtpHost = imapHost.replace(/^mail\./, 'smtp.');
  }

  return {
    host: smtpHost,
    port: 465,
    secure: true,
    auth: {
      user: account.email,
      pass: creds.password
    },
    tls: {
      rejectUnauthorized: false // Resilient against self-signed certificates
    }
  };
}

// Dispatches a real SMTP email
async function sendOutgoingEmail(account: MailAccount, to: string, subject: string, textBody: string) {
  const config = getSmtpConfig(account);
  const transporter = nodemailer.createTransport(config);

  await transporter.sendMail({
    from: `"${account.email.split('@')[0]}" <${account.email}>`,
    to,
    subject,
    text: textBody,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #111111; background: #ffffff; padding: 20px;">
        <div style="white-space: pre-wrap;">${textBody}</div>
      </div>
    `
  });
}

// Synchronize all connected mail accounts
async function syncAllAccounts(vencore: any) {
  const accounts = (await vencore.table('mail_accounts').list()) as MailAccount[];
  
  for (const account of accounts) {
    if (account.status !== 'active') continue;
    
    try {
      await syncAccount(vencore, account);
    } catch (err) {
      console.error(`Failed to sync account: ${account.email}`, err);
    }
  }
}

// Synchronize folders and recent messages for a single mail account via real IMAP
async function syncAccount(vencore: any, account: MailAccount) {
  const creds = account.credentials;
  const client = new ImapFlow({
    host: account.type === 'gmail' ? 'imap.gmail.com' : (creds.host || ''),
    port: account.type === 'gmail' ? 993 : (creds.port || 993),
    secure: true,
    auth: {
      user: account.email,
      pass: creds.password
    },
    logger: false,
    tls: {
      rejectUnauthorized: false
    }
  });

  await client.connect();

  try {
    const folders = await client.list();
    
    for (const folder of folders) {
      // Resolve folder type
      let folderType = 'custom';
      const pathUpper = folder.path.toUpperCase();
      if (pathUpper === 'INBOX' || folder.path === 'INBOX') folderType = 'inbox';
      else if (pathUpper.includes('SENT')) folderType = 'sent';
      else if (pathUpper.includes('SPAM') || pathUpper.includes('JUNK')) folderType = 'spam';
      else if (pathUpper.includes('TRASH') || pathUpper.includes('DELETED')) folderType = 'trash';

      // 1. Fetch total exists & unseen counts
      let totalCount = 0;
      let unreadCount = 0;

      const unseenLock = await client.getMailboxLock(folder.path);
      try {
        const status = client.mailbox;
        totalCount = status ? status.exists : 0;
        const searchResults = await client.search({ seen: false });
        unreadCount = Array.isArray(searchResults) ? searchResults.length : 0;
      } catch {
        // Fallback if mailbox locking failed
      } finally {
        unseenLock.release();
      }

      // Sync folder metadata
      const existingFolders = await vencore.table('mail_folders').list({
        where: { account_id: account.id, name: folder.name }
      });
      
      let folderId = '';
      if (existingFolders.length > 0) {
        folderId = existingFolders[0].id;
        await vencore.table('mail_folders').update(folderId, {
          unread_count: unreadCount,
          total_count: totalCount
        });
      } else {
        const created = await vencore.table('mail_folders').insert({
          account_id: account.id,
          name: folder.name,
          type: folderType,
          unread_count: unreadCount,
          total_count: totalCount
        });
        folderId = created.id as string;
      }

      // 2. Pull recent message headers (fetch last 15 elements to optimize speed)
      if (totalCount === 0) continue;

      const fetchLock = await client.getMailboxLock(folder.path);
      try {
        const startSeq = Math.max(1, totalCount - 14);
        const endSeq = totalCount;
        
        const fetched = client.fetch(`${startSeq}:${endSeq}`, {
          envelope: true,
          flags: true
        });

        for await (const item of fetched) {
          const envelope = item.envelope;
          if (!envelope) continue;

          const externalId = item.uid ? String(item.uid) : `msg_${item.seq}`;

          const subject = envelope.subject || '(No Subject)';
          const sender = envelope.from && envelope.from[0] 
            ? `"${envelope.from[0].name || ''}" <${envelope.from[0].address}>` 
            : 'Unknown';
          const recipient = envelope.to && envelope.to[0] 
            ? envelope.to[0].address 
            : account.email;
          const date = envelope.date ? envelope.date.toISOString() : new Date().toISOString();
          const isRead = item.flags && item.flags.has('\\Seen');
          
          // Flags array
          const flagsArr: string[] = [];
          if (item.flags && item.flags.has('\\Flagged')) flagsArr.push('STARRED');

          const existing = await vencore.table('mail_messages').list({
            where: { account_id: account.id, folder_id: folderId, external_id: externalId }
          }) as MailMessage[];

          if (existing.length > 0) {
            await vencore.table('mail_messages').update(existing[0].id, {
              subject,
              is_read: isRead,
              flags: JSON.stringify(flagsArr)
            });
          } else {
            await vencore.table('mail_messages').insert({
              account_id: account.id,
              folder_id: folderId,
              external_id: externalId,
              subject,
              sender,
              recipient,
              date,
              snippet: subject.slice(0, 100),
              is_read: isRead,
              flags: JSON.stringify(flagsArr)
            });
          }
        }
      } catch (err) {
        console.error(`Failed to fetch messages for folder: ${folder.path}`, err);
      } finally {
        fetchLock.release();
      }
    }
  } finally {
    await client.logout();
  }

  vencore.bus.emit('mail:sync_completed', { accountId: account.id });
}

// Fetch mail message HTML body from real IMAP server
async function fetchMessageBodyFromSource(vencore: any, accountId: string, messageId: string): Promise<string> {
  const msg = (await vencore.table('mail_messages').get(messageId)) as MailMessage;
  if (!msg) throw new Error('Message not found');

  const storedBody = await vencore.storage.get(`body:${msg.external_id}`);
  if (storedBody) {
    try {
      return JSON.parse(storedBody);
    } catch {
      return storedBody;
    }
  }

  const account = (await vencore.table('mail_accounts').get(accountId)) as MailAccount;
  if (!account) throw new Error('Account not found');

  const folder = (await vencore.table('mail_folders').get(msg.folder_id)) as MailFolder;
  if (!folder) throw new Error('Folder not found');

  const creds = account.credentials;
  const client = new ImapFlow({
    host: account.type === 'gmail' ? 'imap.gmail.com' : (creds.host || ''),
    port: account.type === 'gmail' ? 993 : (creds.port || 993),
    secure: true,
    auth: {
      user: account.email,
      pass: creds.password
    },
    logger: false,
    tls: {
      rejectUnauthorized: false
    }
  });

  await client.connect();

  try {
    const lock = await client.getMailboxLock(folder.name);
    try {
      const parsedUid = parseInt(msg.external_id);
      if (isNaN(parsedUid)) {
        return `<div style="padding: 20px; font-family: sans-serif; color: #555555;">This email body could not be fetched (UID sequence invalid).</div>`;
      }

      // Fetch raw email source block
      const fetched = await client.fetchOne(String(parsedUid), { source: true }, { uid: true });
      if (fetched && fetched.source) {
        // Parse email raw headers and content using simpleParser
        const parsed = await simpleParser(fetched.source);
        let bodyHtml = parsed.html || parsed.textAsHtml || `<div style="white-space: pre-wrap;">${parsed.text || ''}</div>`;
        
        return `
          <div style="font-family: sans-serif; padding: 20px; line-height: 1.6; color: #111111; background: #ffffff;">
            ${bodyHtml}
          </div>
        `;
      }
      return `<div style="padding: 20px; font-family: sans-serif; color: #555555;">Email source content is empty.</div>`;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
