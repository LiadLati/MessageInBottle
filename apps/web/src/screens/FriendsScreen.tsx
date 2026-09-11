import { useState, type FormEvent } from 'react';
import { api } from '../api/client.js';
import { Avatar, DeckScreen, ErrorNote, Skeleton } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { useAsync } from '../lib/useAsync.js';

// S9a · Friends and requests. Capacity is surfaced before writing; blocked people never form a list.
export function FriendsScreen() {
  const friends = useAsync(() => api.friends(), []);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await friends.reload();
      if (done) setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    void run(async () => {
      await api.sendFriendRequest(name);
      setUsername('');
    }, `Request sent to @${name.toLowerCase()}`);
  };

  const d = friends.data;
  return (
    <DeckScreen title="Friends" subtitle="Only friends can receive your bottles">
      <form onSubmit={submit} className="row" aria-label="Add a friend">
        <input
          className="input"
          aria-label="Exact username"
          placeholder="Add by exact username"
          autoCapitalize="none"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button className="btn-secondary" disabled={username.trim().length < 2}>
          <Icon name="plus" size={16} />
          Add
        </button>
      </form>
      {notice ? <p className="note">{notice}</p> : null}
      <ErrorNote error={error ?? friends.error} />
      {friends.loading || !d ? (
        <Skeleton />
      ) : (
        <>
          {d.incomingRequests.length > 0 ? (
            <section className="stack">
              <h2 className="section-title">
                {d.incomingRequests.length === 1
                  ? 'One request waiting'
                  : `${d.incomingRequests.length} requests waiting`}
              </h2>
              <ul className="list">
                {d.incomingRequests.map((r) => (
                  <li key={r.id} className="row-item">
                    <Avatar name={r.from.displayName} />
                    <span className="grow">
                      <span className="t-card-title" style={{ display: 'block' }}>
                        {r.from.displayName}
                      </span>
                      <span className="t-meta">@{r.from.username} · asked to be friends</span>
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void run(() => api.acceptFriendRequest(r.id))}
                    >
                      <Icon name="check" size={14} />
                      Accept
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="stack">
            <h2 className="section-title">Your friends · {d.friends.length}</h2>
            {d.friends.length === 0 ? (
              <div className="glass-panel">
                <p className="secondary">No friends yet. Add someone by their exact username.</p>
              </div>
            ) : (
              <ul className="list">
                {d.friends.map((f) => (
                  <li key={f.id} className="row-item">
                    <Avatar name={f.displayName} />
                    <span className="grow">
                      <span className="t-card-title" style={{ display: 'block' }}>
                        {f.displayName}
                      </span>
                      <span className="t-meta">
                        @{f.username} ·{' '}
                        {f.hasShore ? 'Has a shore' : 'No shore yet — cannot receive'}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn-text btn-destructive"
                      onClick={() => {
                        if (
                          confirm(
                            `Block ${f.displayName}? They will not be able to send you bottles.`,
                          )
                        ) {
                          void run(() => api.blockUser(f.username), `${f.displayName} blocked`);
                        }
                      }}
                    >
                      Block
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {d.outgoingRequests.length > 0 ? (
            <section className="stack">
              <h2 className="section-title">Pending</h2>
              <ul className="list">
                {d.outgoingRequests.map((r) => (
                  <li key={r.id} className="row-item ineligible">
                    <Avatar name={r.to.displayName} />
                    <span className="grow">
                      <span className="t-card-title" style={{ display: 'block' }}>
                        {r.to.displayName}
                      </span>
                      <span className="t-meta">Request pending</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </DeckScreen>
  );
}
