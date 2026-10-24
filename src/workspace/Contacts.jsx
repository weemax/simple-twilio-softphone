import React, { useState } from 'react';
import { useWorkspace } from './WorkspaceContext';
import { parseCsv, reviewCsv, saveContact } from './model';
import { formatNumber } from '../formatNumber';
import { ConfirmDialog } from './ConfirmDialog';

export function Contacts({ onText, onCall, onQueue }) {
  const { data, update } = useWorkspace();
  const [query, setQuery] = useState(''),
    [editing, setEditing] = useState(null),
    [error, setError] = useState('');
  const [removing, setRemoving] = useState(null),
    [importing, setImporting] = useState(false),
    [text, setText] = useState('');
  const [csv, setCsv] = useState(null),
    [nameCol, setNameCol] = useState(0),
    [phoneCol, setPhoneCol] = useState(1),
    [notice, setNotice] = useState(''),
    [picked, setPicked] = useState([]);
  const rows = csv ? reviewCsv(csv, nameCol, phoneCol, data.contacts) : [];
  const newRows = rows.filter((r) => r.status === 'New');
  const review = () => {
    try {
      const parsed = parseCsv(text);
      setCsv(parsed);
      setNameCol(0);
      setPhoneCol(Math.min(1, parsed.headers.length - 1));
      setError('');
    } catch (e) {
      setError(e.message);
      setCsv(null);
    }
  };
  const cancelImport = () => {
    setImporting(false);
    setCsv(null);
    setText('');
    setError('');
  };
  function submit(e) {
    e.preventDefault();
    try {
      update((d) => ({ ...d, contacts: saveContact(d.contacts, editing) }));
      setEditing(null);
      setError('');
      setNotice('Contact saved.');
    } catch (e) {
      setError(e.message);
    }
  }
  function importRows() {
    update((d) => {
      // Re-review against current contacts at confirmation, not the old preview.
      const valid = reviewCsv(csv, nameCol, phoneCol, d.contacts).filter(
        (r) => r.status === 'New',
      );
      let contacts = d.contacts;
      valid.forEach((r) => {
        contacts = saveContact(contacts, r);
      });
      return { ...d, contacts };
    });
    setNotice(
      `${newRows.length} new contact${newRows.length === 1 ? '' : 's'} imported. No messages or calls started.`,
    );
    cancelImport();
  }
  const entry = (c) => ({ number: c.number, name: c.name, contactId: c.id });
  const queueContacts = (list) => {
    setNotice(onQueue(list.map(entry)).message);
    setPicked([]);
  };
  const shown = data.contacts.filter((c) =>
    (c.name + ' ' + c.number).toLowerCase().includes(query.toLowerCase()),
  );
  const pickedContacts = data.contacts.filter((c) => picked.includes(c.id));
  const queuedNumbers = new Set(
    [...data.queue.items, ...(data.queue.active ? [data.queue.active] : [])].map(
      (i) => i.number,
    ),
  );
  return (
    <section
      className="contacts workspace-page"
      aria-labelledby="contacts-title"
    >
      <div className="page-heading">
        <div>
          <h2 id="contacts-title">Contacts</h2>
          <p className="muted">Your address book stays on this computer.</p>
        </div>
        <div className="button-row">
          <button
            type="button"
            onClick={() => {
              setEditing({ name: '', number: '' });
              setError('');
            }}
          >
            Add contact
          </button>
          <button
            type="button"
            onClick={() => {
              setImporting(true);
              setEditing(null);
              setError('');
            }}
          >
            Import CSV
          </button>
        </div>
      </div>
      <label className="field">
        Search contacts
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or number"
        />
      </label>
      {notice && <p role="status">{notice}</p>}
      {data.contacts.length > 0 && (
        <div className="button-row contact-selection">
          <button
            type="button"
            className="primary"
            disabled={!pickedContacts.length}
            onClick={() => queueContacts(pickedContacts)}
          >
            Queue selected ({pickedContacts.length})
          </button>
          <button
            type="button"
            disabled={!shown.length}
            onClick={() => setPicked(shown.map((c) => c.id))}
          >
            Select all shown
          </button>
          <button
            type="button"
            disabled={!picked.length}
            onClick={() => setPicked([])}
          >
            Clear selection
          </button>
        </div>
      )}
      {editing && (
        <form className="panel contact-form" onSubmit={submit}>
          <h3>{editing.id ? 'Edit contact' : 'Add contact'}</h3>
          <label className="field">
            Name
            <input
              autoFocus
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            Phone number
            <input
              type="tel"
              value={editing.number}
              onChange={(e) =>
                setEditing({ ...editing, number: e.target.value })
              }
              placeholder="+1 202 555 0101"
              required
            />
          </label>
          <p className="muted small">
            Include + and the country code. One number per contact.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="button-row">
            <button type="submit" className="primary">
              Save contact
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {importing && (
        <section className="panel" aria-label="CSV import review">
          <h3>Review CSV import</h3>
          <p>
            Choose a file or paste CSV with a header row. Nothing imports until
            you confirm.
          </p>
          <label className="field">
            CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files[0];
                if (file) {
                  setCsv(null);
                  try {
                    setText(await file.text());
                    setError('');
                  } catch (_) {
                    setText('');
                    setError(
                      'Could not read this CSV file. Choose another file or paste its contents.',
                    );
                  }
                }
              }}
            />
          </label>
          <label className="field">
            CSV contents
            <textarea
              rows={4}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setCsv(null);
              }}
              placeholder={'Name,Phone\nAlex Rivera,+12025550101'}
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={review}>
              Review rows
            </button>
            <button type="button" onClick={cancelImport}>
              Cancel import
            </button>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {csv && (
            <>
              <div className="button-row">
                <label className="field">
                  Name column
                  <select
                    value={nameCol}
                    onChange={(e) => setNameCol(Number(e.target.value))}
                  >
                    {csv.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Phone column
                  <select
                    value={phoneCol}
                    onChange={(e) => setPhoneCol(Number(e.target.value))}
                  >
                    {csv.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Name</th>
                      <th>Number</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>{r.name || 'Missing name'}</td>
                        <td>{r.rawNumber}</td>
                        <td>
                          {r.status}
                          {r.status === 'Duplicate'
                            ? ' · Skip'
                            : r.status === 'Invalid'
                              ? ' · Fix the CSV and review again'
                              : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                Existing numbers are skipped without overwriting. Invalid rows
                stay excluded. Import never queues or calls contacts.
              </p>
              <button
                type="button"
                className="primary"
                disabled={!newRows.length || nameCol === phoneCol}
                onClick={importRows}
              >
                Import {newRows.length} new contact
                {newRows.length === 1 ? '' : 's'}
              </button>
            </>
          )}
        </section>
      )}
      <div className="contact-grid">
        {shown.map((c) => (
            <article
              className="panel contact-card"
              key={c.id}
              aria-label={c.name}
            >
              <label className="contact-pick">
                <input
                  type="checkbox"
                  checked={picked.includes(c.id)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked
                        ? [...p, c.id]
                        : p.filter((id) => id !== c.id),
                    )
                  }
                />
                <span className="visually-hidden">Select {c.name}</span>
              </label>
              <h3>{c.name}</h3>
              <p className="phone-number">{formatNumber(c.number)}</p>
              {queuedNumbers.has(c.number) && (
                <p className="muted small">In the call queue</p>
              )}
              <div className="button-row">
                <button type="button" onClick={() => onCall(c.number)}>
                  Call
                </button>
                <button
                  type="button"
                  aria-label={`Add ${c.name} to queue`}
                  onClick={() => queueContacts([c])}
                >
                  Add to queue
                </button>
                <button type="button" onClick={() => onText(c.number)}>
                  Text
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(c);
                    setError('');
                  }}
                >
                  Edit
                </button>
                <button type="button" onClick={() => setRemoving(c)}>
                  Remove
                </button>
              </div>
            </article>
          ))}
      </div>
      {!data.contacts.length && (
        <p className="empty-note">
          No contacts yet. Add a contact or review a CSV import to get started.
        </p>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove contact"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            update((d) => ({
              ...d,
              contacts: d.contacts.filter((c) => c.id !== removing.id),
            }));
            setRemoving(null);
          }}
        >
          <p>
            Remove this name and number from Contacts. Message history stays
            unchanged.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
