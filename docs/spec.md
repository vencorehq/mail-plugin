# Vencore Mail Plugin Specification (v1)

This specification details the technical requirements, design patterns, database schemas, and IPC protocol contracts for the `mail-plugin`.

---

## 1. Overview & Goals

The `mail-plugin` provides unified email client functionality (supporting Gmail OAuth and traditional IMAP mail servers) inside the Vencore company management platform. 

### Key Objectives:
* **White-Label Compatibility**: Integrates seamlessly with the host's design system using standard CSS tokens and custom layout components.
* **Low Storage Overhead**: Avoids storing heavy HTML/plain text email bodies locally. Only lists headers, snippet previews, and folder structures.
* **Low Latency**: Utilizes event-driven triggers over the Vencore IPC bus to notify the client when new mail arrives.
* **On-Demand Loading**: Pulls the full body of an email directly from the mail server in real-time only when selected.

---

## 2. Database Schema Definition

The plugin manifest declares the following tables, automatically isolated and scoped by Vencore's multi-tenancy layer (`workspace_id`):

### 2.1 Table: `mail_accounts`
Stores active email connections and OAuth credentials.
```sql
CREATE TABLE plugin_mail-plugin_mail_accounts (
  id UUID PRIMARY KEY,
  type VARCHAR(50) NOT NULL,        -- 'gmail' | 'imap'
  email VARCHAR(255) NOT NULL,
  credentials JSONB NOT NULL,       -- Gmail tokens or IMAP hostname, port, password
  status VARCHAR(50) NOT NULL,      -- 'active' | 'error'
  created_at TIMESTAMPTZ NOT NULL
);
```

### 2.2 Table: `mail_folders`
Stores folder metadata and unread indicators.
```sql
CREATE TABLE plugin_mail-plugin_mail_folders (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES mail_accounts(id),
  name VARCHAR(255) NOT NULL,       -- 'INBOX', 'Sent Messages', etc.
  type VARCHAR(50) NOT NULL,        -- 'inbox' | 'sent' | 'spam' | 'trash' | 'custom'
  unread_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0
);
```

### 2.3 Table: `mail_messages`
Stores message metadata for list indexing.
```sql
CREATE TABLE plugin_mail-plugin_mail_messages (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES mail_accounts(id),
  folder_id UUID REFERENCES mail_folders(id),
  external_id VARCHAR(255) UNIQUE,  -- Gmail message ID or IMAP UID
  subject VARCHAR(255) NOT NULL,
  sender VARCHAR(255) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  date TIMESTAMPTZ NOT NULL,
  snippet TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  flags JSONB                       -- Custom tags or category folders
);
```

---

## 3. Communication Protocols (IPC Bus Contracts)

Because the plugin runs in an isolated sandbox, all communication with the frontend client occurs via postMessages handled by Vencore's `vencore.bus`.

### 3.1 Event: `mail:fetch_body_request`
Sent from the client to the server sandbox to fetch an email body on-demand.
* **Payload**:
  ```typescript
  {
    messageId: string;
    accountId: string;
    replyEvent: string; // Dynamic callback event name, e.g. "mail:body_received_xyz"
  }
  ```

### 3.2 Event: `mail:body_received` (replyEvent)
Sent from the server sandbox back to the client with the fetched HTML body.
* **Payload**:
  ```typescript
  {
    success: boolean;
    body?: string;       // HTML or plain text content
    error?: string;      // Error message if fetch failed
  }
  ```

### 3.3 Event: `mail:sync_now_request`
Sent from the client to force an immediate database sync pull.
* **Payload**:
  ```typescript
  {
    replyEvent: string;
  }
  ```

### 3.4 Event: `mail:sync_completed`
Sent from the server sandbox to notify the client that a sync has finished and new message headers are in the local tables.
* **Payload**:
  ```typescript
  {
    accountId: string;
  }
  ```

---

## 4. Synchronization Logic (Delta Sync)

1. **Scheduling**: A cron job runs inside the sandbox every 60 seconds (`vencore.cron.register('*/1 * * * *', sync)`).
2. **Delta Fetching**:
   * Queries the database for the latest message timestamp `last_sync_date` in `mail_messages`.
   * Queries the external API (Gmail `/messages` list or IMAP `UID SEARCH`) for messages newer than `last_sync_date`.
   * Upserts the metadata to the database, ignoring messages already present.
3. **Latency**: The sync runs asynchronously. On completion, it triggers `vencore.bus.emit('mail:sync_completed')`, forcing the UI to perform a fast client-side table read without reloading the page.
