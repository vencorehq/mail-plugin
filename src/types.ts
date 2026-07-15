export interface MailAccount {
  id: string;
  type: 'gmail' | 'imap';
  email: string;
  credentials: {
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    secure?: boolean;
  };
  status: 'active' | 'error';
  created_at: string;
}

export interface MailFolder {
  id: string;
  account_id: string;
  name: string;
  type: 'inbox' | 'sent' | 'spam' | 'trash' | 'custom';
  unread_count: number;
  total_count: number;
}

export interface MailMessage {
  id: string;
  account_id: string;
  folder_id: string;
  external_id: string;
  subject: string;
  sender: string;
  recipient: string;
  date: string;
  snippet: string;
  is_read: boolean;
  flags: string[];
}
