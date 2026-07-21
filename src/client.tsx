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
  const [selectedFolderId, setSelectedFolderId] = useState<string>('all'); // 'all', 'starred', or folder.id
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

  // Compose / Reply / Forward email modal state
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
        if (selectedFolderId === 'all') {
          loadMessages(data[0].id);
          setSelectedFolderId(data[0].id);
        } else if (selectedFolderId !== 'starred') {
          loadMessages(selectedFolderId);
        } else {
          loadStarredMessages(accountId);
        }
      } else {
        setFolders([]);
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to load folders:', err);
    }
  };

  const loadMessages = async (folderId: string) => {
    try {
      const data = (await vencore.table('mail_messages').list({ where: { folder_id: folderId } })) as MailMessage[];
      const sorted = data.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setMessages(sorted);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  };

  const loadStarredMessages = async (accountId: string) => {
    try {
      const data = (await vencore.table('mail_messages').list({ where: { account_id: accountId } })) as MailMessage[];
      const starred = data.filter(m => {
        const flags = m.flags;
        const currentFlags: string[] = typeof flags === 'string'
          ? JSON.parse(flags)
          : Array.isArray(flags) ? flags : [];
        return currentFlags.includes('STARRED');
      });
      const sorted = starred.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setMessages(sorted);
    } catch (err) {
      console.error('Failed to load starred messages:', err);
    }
  };

  // 2. Select Message and Fetch Body Dynamically
  const handleSelectMessage = async (msg: MailMessage) => {
    setSelectedMsg(msg);
    setMsgBody('');
    setLoadingBody(true);

    if (!msg.is_read) {
      try {
        await vencore.table('mail_messages').update(msg.id, { is_read: true });
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_read: true } : m));
        setFolders(prev => prev.map(f => f.id === msg.folder_id ? { ...f, unread_count: Math.max(0, f.unread_count - 1) } : f));
      } catch (err) {
        console.error('Failed to update message flags:', err);
      }
    }

    try {
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

  // 3. Trigger manual sync
  const handleSyncNow = async () => {
    setIsSyncing(true);
    try {
      const res = await vencore.invoke('/sync-now');
      if (res && res.success) {
        await loadAccounts();
        if (selectedAccountId) {
          await loadFolders(selectedAccountId);
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

  // 5. Delete Account
  const handleDeleteAccount = async () => {
    if (!selectedAccountId) return;
    if (!confirm('Are you sure you want to disconnect this email account? All local folders and messages will be removed.')) return;

    try {
      await vencore.invoke('/delete-account', { accountId: selectedAccountId });
      setSelectedAccountId('');
      setSelectedMsg(null);
      setFolders([]);
      setMessages([]);
      await loadAccounts();
    } catch (err) {
      alert('Failed to disconnect account: ' + err);
    }
  };

  // 6. Send Composed / Replied / Forwarded Email
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

  // 7. Toggle Star Status
  const handleToggleStar = async (msg: MailMessage, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      const res = await vencore.invoke('/toggle-star', { messageId: msg.id });
      if (res && res.success) {
        const nextStarred = res.isStarred;
        setMessages(prev => prev.map(m => {
          if (m.id === msg.id) {
            const currentFlags: string[] = typeof m.flags === 'string'
              ? JSON.parse(m.flags)
              : Array.isArray(m.flags) ? m.flags : [];
            const updatedFlags = nextStarred
              ? [...currentFlags, 'STARRED']
              : currentFlags.filter(f => f !== 'STARRED');
            return { ...m, flags: updatedFlags }; // Saved locally as array to match typescript type
          }
          return m;
        }));

        if (selectedMsg?.id === msg.id) {
          const currentFlags: string[] = typeof selectedMsg.flags === 'string'
            ? JSON.parse(selectedMsg.flags)
            : Array.isArray(selectedMsg.flags) ? selectedMsg.flags : [];
          const updatedFlags = nextStarred
            ? [...currentFlags, 'STARRED']
            : currentFlags.filter(f => f !== 'STARRED');
          setSelectedMsg({ ...selectedMsg, flags: updatedFlags });
        }
      }
    } catch (err) {
      console.error('Failed to toggle star:', err);
    }
  };

  // 8. Delete / Move to Trash
  const handleDeleteMessage = async (msg: MailMessage, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      const res = await vencore.invoke('/delete-message', {
        messageId: msg.id,
        accountId: selectedAccountId
      });

      if (res && res.success) {
        setMessages(prev => prev.filter(m => m.id !== msg.id));
        if (selectedMsg?.id === msg.id) {
          setSelectedMsg(null);
        }
        await loadFolders(selectedAccountId);
      }
    } catch (err) {
      alert('Failed to delete message: ' + err);
    }
  };

  // 9. Open Reply Modal
  const handleReply = () => {
    if (!selectedMsg) return;
    setComposeTo(selectedMsg.sender);
    setComposeSubject(selectedMsg.subject.startsWith('Re:') ? selectedMsg.subject : `Re: ${selectedMsg.subject}`);
    setComposeBody(`\n\n--- On ${new Date(selectedMsg.date).toLocaleString()}, ${selectedMsg.sender} wrote:\n> ${selectedMsg.snippet}`);
    setShowComposeModal(true);
  };

  // 10. Open Forward Modal
  const handleForward = () => {
    if (!selectedMsg) return;
    setComposeTo('');
    setComposeSubject(selectedMsg.subject.startsWith('Fwd:') ? selectedMsg.subject : `Fwd: ${selectedMsg.subject}`);
    setComposeBody(`\n\n---------- Forwarded message ---------\nFrom: ${selectedMsg.sender}\nDate: ${new Date(selectedMsg.date).toLocaleString()}\nSubject: ${selectedMsg.subject}\nTo: ${selectedMsg.recipient}\n\n${selectedMsg.snippet}`);
    setShowComposeModal(true);
  };

  // Helper to parse flags securely
  const isMessageStarred = (msg: MailMessage) => {
    const rawFlags = msg.flags;
    const currentFlags: string[] = typeof rawFlags === 'string'
      ? JSON.parse(rawFlags)
      : Array.isArray(rawFlags) ? rawFlags : [];
    return currentFlags.includes('STARRED');
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

  // Calculate sender initial & gradient for avatar badges
  const getAvatarStyle = (name: string) => {
    const gradients = [
      'linear-gradient(135deg, #10b981, #059669)',
      'linear-gradient(135deg, #6366f1, #4f46e5)',
      'linear-gradient(135deg, #8b5cf6, #7c3aed)',
      'linear-gradient(135deg, #ec4899, #db2777)',
      'linear-gradient(135deg, #f59e0b, #d97706)',
      'linear-gradient(135deg, #3b82f6, #2563eb)'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const index = Math.abs(hash) % gradients.length;
    return { background: gradients[index], color: '#fff' };
  };

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
          {selectedAccountId && (
            <button onClick={handleDeleteAccount} style={deleteAccBtn} title="Disconnect selected account">✕</button>
          )}
        </div>

        {/* Compose Button */}
        <button 
          onClick={() => {
            if (!selectedAccountId) {
              alert('Please connect and select an account first!');
              return;
            }
            setComposeTo('');
            setComposeSubject('');
            setComposeBody('');
            setShowComposeModal(true);
          }} 
          style={composeBtn}
        >
          Compose Mail
        </button>

        {/* Folders & Starred Navigation */}
        <div style={foldersList}>
          <button
            onClick={() => {
              setSelectedFolderId('starred');
              if (selectedAccountId) loadStarredMessages(selectedAccountId);
              setSelectedMsg(null);
            }}
            style={{
              ...folderTab,
              background: selectedFolderId === 'starred' ? 'var(--surface2)' : 'transparent',
              fontWeight: selectedFolderId === 'starred' ? 600 : 400
            }}
          >
            <span>Starred</span>
          </button>

          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }} />

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
          {filteredMessages.map(msg => {
            const isStarred = isMessageStarred(msg);
            const senderName = msg.sender.split(' <')[0].replace(/"/g, '');
            const initial = (senderName[0] || 'M').toUpperCase();

            return (
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ ...avatarBadge, ...getAvatarStyle(senderName) }}>
                      {initial}
                    </div>
                    <span style={{ ...messageSender, fontWeight: msg.is_read ? 500 : 700 }}>
                      {senderName}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      onClick={e => handleToggleStar(msg, e)}
                      style={starIconBtn}
                      title={isStarred ? 'Unstar' : 'Star'}
                    >
                      {isStarred ? '★' : '☆'}
                    </button>
                    <span style={messageDate}>
                      {new Date(msg.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                </div>
                <div style={{ ...messageSubject, fontWeight: msg.is_read ? 400 : 600 }}>{msg.subject}</div>
                <div style={messageSnippet}>{msg.snippet}</div>
              </div>
            );
          })}

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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <h2 style={readerSubject}>{selectedMsg.subject}</h2>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={handleReply} style={readerActionBtn}>Reply</button>
                  <button onClick={handleForward} style={readerActionBtn}>Forward</button>
                  <button
                    onClick={e => handleToggleStar(selectedMsg, e)}
                    style={readerActionBtn}
                  >
                    {isMessageStarred(selectedMsg) ? 'Starred' : 'Star'}
                  </button>
                  <button onClick={e => handleDeleteMessage(selectedMsg, e)} style={readerDeleteBtn} title="Delete email">
                    Delete
                  </button>
                </div>
              </div>

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

      {/* Compose / Reply / Forward Modal */}
      {showComposeModal && (
        <div style={modalBackdrop}>
          <div style={{ ...modalCard, width: 520 }}>
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

// Styling Constants
const container: React.CSSProperties = { display: 'flex', height: '100vh', background: 'var(--bg)', fontFamily: 'DM Sans, sans-serif', overflow: 'hidden' };
const sidebar: React.CSSProperties = { width: 230, borderRight: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', padding: 16, flexShrink: 0 };
const sidebarHeader: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' };
const accountSelector: React.CSSProperties = { flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', fontSize: 12, color: 'var(--text)' };
const addButton: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 14, fontWeight: 700 };
const deleteAccBtn: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 700 };
const composeBtn: React.CSSProperties = { width: '100%', padding: '9px 0', borderRadius: 6, border: 'none', background: 'var(--text)', color: 'var(--bg)', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 16, textAlign: 'center' };
const foldersList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 };
const folderTab: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontSize: 13, color: 'var(--text)' };
const unreadBadge: React.CSSProperties = { background: 'var(--blue)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 999 };
const syncButton: React.CSSProperties = { marginTop: 'auto', padding: '10px 0', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface2)', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text)' };

const messagesCol: React.CSSProperties = { width: 340, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 };
const searchBarContainer: React.CSSProperties = { padding: 16, borderBottom: '1px solid var(--border)', background: 'var(--surface)' };
const searchInput: React.CSSProperties = { width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', fontSize: 13, color: 'var(--text)' };
const messagesList: React.CSSProperties = { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' };
const messageCard: React.CSSProperties = { padding: '14px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.15s ease' };
const messageHeader: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'center' };
const avatarBadge: React.CSSProperties = { width: 22, height: 22, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 };
const messageSender: React.CSSProperties = { fontSize: 13, color: 'var(--text)' };
const starIconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text2)', padding: 0 };
const messageDate: React.CSSProperties = { fontSize: 11, color: 'var(--text3)' };
const messageSubject: React.CSSProperties = { fontSize: 13, color: 'var(--text)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const messageSnippet: React.CSSProperties = { fontSize: 12, color: 'var(--text2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };

const readerCol: React.CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)' };
const readerContent: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%' };
const readerHeader: React.CSSProperties = { padding: '24px 32px', borderBottom: '1px solid var(--border)' };
const readerSubject: React.CSSProperties = { margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text)', fontFamily: 'Instrument Serif, serif' };
const readerActionBtn: React.CSSProperties = { padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--text)' };
const readerDeleteBtn: React.CSSProperties = { padding: '6px 12px', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, background: 'rgba(239,68,68,0.08)', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#ef4444' };
const readerMeta: React.CSSProperties = { fontSize: 13, color: 'var(--text2)', display: 'flex', flexDirection: 'column', gap: 4 };
const readerDate: React.CSSProperties = { fontSize: 12, color: 'var(--text3)', marginTop: 2 };
const readerBodyContainer: React.CSSProperties = { flex: 1, padding: '24px 32px', background: 'var(--bg)', display: 'flex' };
const readerIframe: React.CSSProperties = { width: '100%', height: '100%', border: '1px solid var(--border)', background: '#ffffff', color: '#111111', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.03)' };
const bodyLoader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: 'var(--text3)', fontSize: 14 };
const emptyState: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', fontSize: 14 };

const modalBackdrop: React.CSSProperties = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalCard: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: 400, padding: 24, boxShadow: '0 8px 24px rgba(0,0,0,0.15)' };
const modalTitle: React.CSSProperties = { margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: 'var(--text)' };
const modalForm: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const modalLabel: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--text2)', marginBottom: -6 };
const modalInput: React.CSSProperties = { padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', fontSize: 13, color: 'var(--text)' };
const modalActions: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 };
const modalCancelBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', cursor: 'pointer', fontSize: 13, color: 'var(--text)' };
const modalSubmitBtn: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--text)', color: 'var(--bg)', cursor: 'pointer', fontSize: 13, fontWeight: 500 };
