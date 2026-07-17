import React, { useEffect, useState } from 'react';
import type { MailAccount, MailFolder, MailMessage } from './types';

// Module-scoped vencore reference passed down by the host runtime on setup
let vencore: any;

export default {
  setup(v: any) {
    vencore = v;
    v.registerPage('/mail', MailWorkspace);
    v.registerPage('/', MailWorkspace);
  }
};

function MailWorkspace() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [selectedMsg, setSelectedMsg] = useState<MailMessage | null>(null);
  const [msgBody, setMsgBody] = useState<string>('');
  const [loadingBody, setLoadingBody] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  
  // Account creation modal state
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [newAccType, setNewAccType] = useState<'gmail' | 'imap'>('gmail');
  const [newAccEmail, setNewAccEmail] = useState<string>('');
  const [newAccHost, setNewAccHost] = useState<string>('');
  const [newAccPort, setNewAccPort] = useState<number>(993);
  const [newAccPassword, setNewAccPassword] = useState<string>('');

  // Compose email modal state
  const [showComposeModal, setShowComposeModal] = useState<boolean>(false);
  const [composeTo, setComposeTo] = useState<string>('');
  const [composeSubject, setComposeSubject] = useState<string>('');
  const [composeBody, setComposeBody] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);

  // 1. Initial Load: Fetch Accounts
  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const data = (await vencore.table('mail_accounts').list()) as MailAccount[];
      setAccounts(data);
      if (data.length > 0 && !selectedAccountId) {
        setSelectedAccountId(data[0].id);
        loadFolders(data[0].id);
      }
    } catch (err) {
      console.error('Failed to load mail accounts:', err);
    }
  };

  const loadFolders = async (accountId: string) => {
    try {
      const data = (await vencore.table('mail_folders').list({ where: { account_id: accountId } })) as MailFolder[];
      setFolders(data);
      if (data.length > 0) {
        setSelectedFolderId(data[0].id);
        loadMessages(data[0].id);
      } else {
        setFolders([]);
        setMessages([]);
        setSelectedFolderId('');
      }
    } catch (err) {
      console.error('Failed to load folders:', err);
    }
  };

  const loadMessages = async (folderId: string) => {
    try {
      const data = (await vencore.table('mail_messages').list({ where: { folder_id: folderId } })) as MailMessage[];
      // Sort messages descending by date
      const sorted = data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setMessages(sorted);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  };

  // 2. Fetch Mail Body Dynamically (On-Demand) to keep local storage lightweight
  const handleSelectMessage = async (msg: MailMessage) => {
    setSelectedMsg(msg);
    setMsgBody('');
    setLoadingBody(true);

    // If message is unread, mark it as read in the DB directly
    if (!msg.is_read) {
      try {
        await vencore.table('mail_messages').update(msg.id, { is_read: true });
        // Update local state arrays to clear unread badges instantly
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_read: true } : m));
        setFolders(prev => prev.map(f => f.id === msg.folder_id ? { ...f, unread_count: Math.max(0, f.unread_count - 1) } : f));
      } catch (err) {
        console.error('Failed to update message flags:', err);
      }
    }

    try {
      // Invoke HTTP endpoint in sandbox to retrieve message body dynamically
      const res = await vencore.invoke('/fetch-body', {
        messageId: msg.id,
        accountId: selectedAccountId
      });

      if (res && res.success && res.body) {
        setMsgBody(res.body);
      } else {
        setMsgBody(`<p style="color:red; padding:16px;">Failed to load email: ${res?.error || 'Unknown error'}</p>`);
      }
    } catch (err) {
      setMsgBody(`<p style="color:red; padding:16px;">Failed to load email: ${String(err)}</p>`);
    } finally {
      setLoadingBody(false);
    }
  };

  // 3. Trigger manual sync request
  const handleSyncNow = async () => {
    setIsSyncing(true);
    try {
      const res = await vencore.invoke('/sync-now');
      if (res && res.success) {
        await loadAccounts();
        if (selectedAccountId) {
          await loadFolders(selectedAccountId);
          if (selectedFolderId) {
            await loadMessages(selectedFolderId);
          }
        }
      } else {
        alert(`Sync failed: ${res?.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Sync failed: ${String(err)}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // 4. Create new mail account
  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccEmail) return;

    try {
      await vencore.table('mail_accounts').insert({
        type: newAccType,
        email: newAccEmail,
        credentials: {
          host: newAccType === 'imap' ? newAccHost : undefined,
          port: newAccType === 'imap' ? newAccPort : undefined,
          password: newAccPassword
        },
        status: 'active',
        created_at: new Date().toISOString()
      });

      setShowAddModal(false);
      setNewAccEmail('');
      setNewAccHost('');
      setNewAccPassword('');
      await loadAccounts();
    } catch (err) {
      alert('Failed to connect account: ' + err);
    }
  };

  // 5. Send composed email
  const handleSendMail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!composeTo || !composeBody || !selectedAccountId) return;

    setIsSending(true);
    try {
      const res = await vencore.invoke('/send-mail', {
        accountId: selectedAccountId,
        to: composeTo,
        subject: composeSubject || '(No Subject)',
        body: composeBody
      });

      if (res && res.success) {
        setShowComposeModal(false);
        setComposeTo('');
        setComposeSubject('');
        setComposeBody('');
        // Reload folders and messages so it displays in Sent folder
        await loadFolders(selectedAccountId);
      } else {
        alert(`Failed to send email: ${res?.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Error sending email: ${String(err)}`);
    } finally {
      setIsSending(false);
    }
  };

  // Filter messages based on search query
  const filteredMessages = messages.filter(msg => {
    const query = searchQuery.toLowerCase();
    return (
      msg.subject.toLowerCase().includes(query) ||
      msg.sender.toLowerCase().includes(query) ||
      msg.snippet.toLowerCase().includes(query)
    );
  });

  return (
    <div style={container}>
      {/* Sidebar - Accounts & Folders */}
      <aside style={sidebar}>
        <div style={sidebarHeader}>
          <select 
            value={selectedAccountId} 
            onChange={e => {
              setSelectedAccountId(e.target.value);
              loadFolders(e.target.value);
              setSelectedMsg(null);
            }} 
            style={accountSelector}
          >
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id}>{acc.email} ({acc.type})</option>
            ))}
            {accounts.length === 0 && <option value="">No Accounts Linked</option>}
          </select>
          <button onClick={() => setShowAddModal(true)} style={addButton} title="Connect new account">+</button>
        </div>

        {/* Compose Button */}
        <button 
          onClick={() => {
            if (!selectedAccountId) {
              alert('Please connect and select an account first!');
              return;
            }
            setShowComposeModal(true);
          }} 
          style={composeBtn}
        >
          Compose Mail
        </button>

        {/* Folders List */}
        <div style={foldersList}>
          {folders.map(folder => (
            <button
              key={folder.id}
              onClick={() => {
                setSelectedFolderId(folder.id);
                loadMessages(folder.id);
                setSelectedMsg(null);
              }}
              style={{
                ...folderTab,
                background: selectedFolderId === folder.id ? 'var(--surface2)' : 'transparent',
                fontWeight: selectedFolderId === folder.id ? 600 : 400
              }}
            >
              <span>{folder.name}</span>
              {folder.unread_count > 0 && (
                <span style={unreadBadge}>{folder.unread_count}</span>
              )}
            </button>
          ))}
        </div>

        <button onClick={handleSyncNow} disabled={isSyncing} style={syncButton}>
          {isSyncing ? 'Syncing...' : 'Sync Inbox Now'}
        </button>
      </aside>

      {/* Messages List Column */}
      <section style={messagesCol}>
        <div style={searchBarContainer}>
          <input
            type="text"
            placeholder="Search mail..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={searchInput}
          />
        </div>

        <div style={messagesList}>
          {filteredMessages.map(msg => (
            <div
              key={msg.id}
              onClick={() => handleSelectMessage(msg)}
              style={{
                ...messageCard,
                background: selectedMsg?.id === msg.id ? 'var(--surface2)' : 'var(--surface)',
                borderLeft: msg.is_read ? '3px solid transparent' : '3px solid var(--blue)'
              }}
            >
              <div style={messageHeader}>
                <span style={{ ...messageSender, fontWeight: msg.is_read ? 500 : 700 }}>
                  {msg.sender.split(' <')[0]}
                </span>
                <span style={messageDate}>
                  {new Date(msg.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <div style={{ ...messageSubject, fontWeight: msg.is_read ? 400 : 600 }}>{msg.subject}</div>
              <div style={messageSnippet}>{msg.snippet}</div>
            </div>
          ))}

          {filteredMessages.length === 0 && (
            <div style={emptyState}>No messages in this folder.</div>
          )}
        </div>
      </section>

      {/* Message Reader Pane */}
      <section style={readerCol}>
        {selectedMsg ? (
          <div style={readerContent}>
            <div style={readerHeader}>
              <h2 style={readerSubject}>{selectedMsg.subject}</h2>
              <div style={readerMeta}>
                <div>From: <strong>{selectedMsg.sender}</strong></div>
                <div>To: {selectedMsg.recipient}</div>
                <div style={readerDate}>
                  Date: {new Date(selectedMsg.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                </div>
              </div>
            </div>

            <div style={readerBodyContainer}>
              {loadingBody ? (
                <div style={bodyLoader}>Loading message content...</div>
              ) : (
                <iframe
                  srcDoc={msgBody}
                  title="Message Body"
                  sandbox="allow-same-origin"
                  style={readerIframe}
                />
              )}
            </div>
          </div>
        ) : (
          <div style={emptyState}>Select an email to view its content.</div>
        )}
      </section>

      {/* Connect Account Modal */}
      {showAddModal && (
        <div style={modalBackdrop}>
          <div style={modalCard}>
            <h3 style={modalTitle}>Connect Email Account</h3>
            <form onSubmit={handleAddAccount} style={modalForm}>
              <label style={modalLabel}>Connection Type</label>
              <select value={newAccType} onChange={e => setNewAccType(e.target.value as any)} style={modalInput}>
                <option value="gmail">Gmail (Google OAuth)</option>
                <option value="imap">IMAP</option>
              </select>

              <label style={modalLabel}>Email Address</label>
              <input
                type="email"
                required
                value={newAccEmail}
                onChange={e => setNewAccEmail(e.target.value)}
                placeholder="user@example.com"
                style={modalInput}
              />

              {newAccType === 'imap' && (
                <>
                  <label style={modalLabel}>IMAP Hostname</label>
                  <input
                    type="text"
                    required
                    value={newAccHost}
                    onChange={e => setNewAccHost(e.target.value)}
                    placeholder="imap.example.com"
                    style={modalInput}
                  />
                  <label style={modalLabel}>IMAP Port</label>
                  <input
                    type="number"
                    required
                    value={newAccPort}
                    onChange={e => setNewAccPort(parseInt(e.target.value))}
                    style={modalInput}
                  />
                </>
              )}

              <label style={modalLabel}>Password / Key</label>
              <input
                type="password"
                required
                value={newAccPassword}
                onChange={e => setNewAccPassword(e.target.value)}
                placeholder="Account password"
                style={modalInput}
              />

              <div style={modalActions}>
                <button type="button" onClick={() => setShowAddModal(false)} style={modalCancelBtn}>Cancel</button>
                <button type="submit" style={modalSubmitBtn}>Connect Account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Compose Modal */}
      {showComposeModal && (
        <div style={modalBackdrop}>
          <div style={{ ...modalCard, width: 500 }}>
            <h3 style={modalTitle}>New Message</h3>
            <form onSubmit={handleSendMail} style={modalForm}>
              <label style={modalLabel}>To</label>
              <input
                type="email"
                required
                value={composeTo}
                onChange={e => setComposeTo(e.target.value)}
                placeholder="recipient@example.com"
                style={modalInput}
              />

              <label style={modalLabel}>Subject</label>
              <input
                type="text"
                value={composeSubject}
                onChange={e => setComposeSubject(e.target.value)}
                placeholder="Email subject"
                style={modalInput}
              />

              <label style={modalLabel}>Message</label>
              <textarea
                required
                rows={10}
                value={composeBody}
                onChange={e => setComposeBody(e.target.value)}
                placeholder="Write your email body here..."
                style={{ ...modalInput, fontFamily: 'inherit', resize: 'vertical' }}
              />

              <div style={modalActions}>
                <button type="button" onClick={() => setShowComposeModal(false)} style={modalCancelBtn}>Cancel</button>
                <button type="submit" disabled={isSending} style={modalSubmitBtn}>
                  {isSending ? 'Sending...' : 'Send Email'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Styling Constants (Inline CSS for iframe sandbox environment)
const container: React.CSSProperties = { display: 'flex', height: '100vh', background: 'var(--bg)', fontFamily: 'DM Sans, sans-serif', overflow: 'hidden' };
const sidebar: React.CSSProperties = { width: 230, borderRight: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', padding: 16, flexShrink: 0 };
const sidebarHeader: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 12 };
const accountSelector: React.CSSProperties = { flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', fontSize: 13, color: 'var(--text)' };
const addButton: React.CSSProperties = { width: 30, height: 30, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', cursor: 'pointer', fontSize: 16, fontWeight: 700 };
const composeBtn: React.CSSProperties = { width: '100%', padding: '10px 0', borderRadius: 6, border: 'none', background: 'var(--text)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 20, textAlign: 'center', transition: 'opacity 0.15s ease' };
const foldersList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 };
const folderTab: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontSize: 13, color: 'var(--text)' };
const unreadBadge: React.CSSProperties = { background: 'var(--blue)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 999 };
const syncButton: React.CSSProperties = { marginTop: 'auto', padding: '10px 0', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface2)', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text)' };

const messagesCol: React.CSSProperties = { width: 340, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 };
const searchBarContainer: React.CSSProperties = { padding: 16, borderBottom: '1px solid var(--border)', background: 'var(--surface)' };
const searchInput: React.CSSProperties = { width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', fontSize: 13, color: 'var(--text)' };
const messagesList: React.CSSProperties = { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' };
const messageCard: React.CSSProperties = { padding: '14px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.15s ease' };
const messageHeader: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', marginBottom: 4 };
const messageSender: React.CSSProperties = { fontSize: 13, color: 'var(--text)' };
const messageDate: React.CSSProperties = { fontSize: 11, color: 'var(--text3)' };
const messageSubject: React.CSSProperties = { fontSize: 13, color: 'var(--text)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const messageSnippet: React.CSSProperties = { fontSize: 12, color: 'var(--text2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };

const readerCol: React.CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)' };
const readerContent: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%' };
const readerHeader: React.CSSProperties = { padding: '24px 32px', borderBottom: '1px solid var(--border)' };
const readerSubject: React.CSSProperties = { margin: '0 0 12px', fontSize: 20, fontWeight: 700, color: 'var(--text)', fontFamily: 'Instrument Serif, serif' };
const readerMeta: React.CSSProperties = { fontSize: 13, color: 'var(--text2)', display: 'flex', flexDirection: 'column', gap: 4 };
const readerDate: React.CSSProperties = { fontSize: 12, color: 'var(--text3)', marginTop: 2 };
const readerBodyContainer: React.CSSProperties = { flex: 1, padding: 32, background: 'var(--bg)', display: 'flex' };
const readerIframe: React.CSSProperties = { width: '100%', height: '100%', border: 'none', background: 'var(--surface)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.02)' };
const bodyLoader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: 'var(--text3)', fontSize: 14 };
const emptyState: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', fontSize: 14 };

const modalBackdrop: React.CSSProperties = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalCard: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: 400, padding: 24, boxShadow: '0 4px 12px rgba(0,0,0,0.08)' };
const modalTitle: React.CSSProperties = { margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: 'var(--text)' };
const modalForm: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const modalLabel: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--text2)', marginBottom: -6 };
const modalInput: React.CSSProperties = { padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', fontSize: 13, color: 'var(--text)' };
const modalActions: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 };
const modalCancelBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', cursor: 'pointer', fontSize: 13, color: 'var(--text)' };
const modalSubmitBtn: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--text)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 };
