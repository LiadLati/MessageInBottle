import { useState, type FormEvent } from 'react';
import { api } from '../api/client.js';
import { Empty, ErrorNote, Loading, Screen } from '../components/ui.js';
import { useAsync } from '../lib/useAsync.js';

export function FriendsScreen() {
  const friends = useAsync(() => api.friends(), []);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<Error | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      await friends.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.sendFriendRequest(username.trim());
      setUsername('');
    });
  };

  const d = friends.data;
  return (
    <Screen title="Friends">
      <form onSubmit={submit} className="row">
        <input
          aria-label="Exact username"
          placeholder="Exact username"
          autoCapitalize="none"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button className="btn" disabled={username.trim().length < 2}>
          Add
        </button>
      </form>
      <ErrorNote error={error ?? friends.error} />
      {friends.loading || !d ? (
        <Loading />
      ) : (
        <>
          {d.incomingRequests.length > 0 ? (
            <section>
              <h2>Requests</h2>
              <ul className="list">
                {d.incomingRequests.map((r) => (
                  <li key={r.id} className="list-item">
                    <span>
                      <strong>{r.from.displayName}</strong>{' '}
                      <span className="muted">@{r.from.username}</span>
                    </span>
                    <button
                      className="btn small"
                      onClick={() => void run(() => api.acceptFriendRequest(r.id))}
                    >
                      Accept
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h2>Approved friends</h2>
            {d.friends.length === 0 ? (
              <Empty>No friends yet. Add someone by their exact username.</Empty>
            ) : (
              <ul className="list">
                {d.friends.map((f) => (
                  <li key={f.id} className="list-item">
                    <span>
                      <strong>{f.displayName}</strong> <span className="muted">@{f.username}</span>
                      {!f.hasShore ? <span className="muted small"> · no shore yet</span> : null}
                    </span>
                    <button
                      className="btn small danger"
                      onClick={() => {
                        if (
                          confirm(
                            `Block ${f.displayName}? They will not be able to send you bottles.`,
                          )
                        ) {
                          void run(() => api.blockUser(f.username));
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
            <section>
              <h2>Pending</h2>
              <ul className="list">
                {d.outgoingRequests.map((r) => (
                  <li key={r.id} className="list-item muted">
                    {r.to.displayName} — awaiting approval
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </Screen>
  );
}
