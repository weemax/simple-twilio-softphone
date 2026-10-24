import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSms } from '../contexts/SmsContext';
import { emptyWorkspace, inboundIds } from './model';
import { normalizeQueue } from './queue';

const WorkspaceContext = createContext(null);
export function WorkspaceProvider({ children }) {
  const { snapshot, prunePhotos } = useSms();
  const [data, setData] = useState(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const current = useRef(data),
    writes = useRef(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.operator?.config?.get('workspace'))
      .then((saved) => {
        if (cancelled) return;
        const next = {
          ...emptyWorkspace(),
          ...(saved && typeof saved === 'object' ? saved : {}),
        };
        // Metadata saved before the queue existed has none; a call that was
        // in progress when the app closed is recorded, never resumed.
        next.queue = normalizeQueue(next.queue);
        current.current = next;
        setData(next);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled)
          setSaveError(
            'Could not load local workspace. Restart the app before editing contacts or drafts.',
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Once the saved workspace is read, the local service may delete draft photos
  // it no longer lists (a removal that never finished); photos of messages are untouched.
  const pruned = useRef(false);
  useEffect(() => {
    if (!ready || pruned.current || typeof prunePhotos !== 'function') return;
    pruned.current = true;
    prunePhotos(
      Object.values(current.current.attachments || {})
        .flat()
        .map((p) => p.id),
    );
  }, [ready, prunePhotos]);
  const update = useCallback((fn) => {
    const next = fn(current.current);
    if (next === current.current) return;
    current.current = next;
    setData(next);
    // Do not debounce drafts. Serialize writes so an older response cannot overwrite newer text.
    writes.current = writes.current
      .catch(() => {})
      .then(async () => {
        if (window.operator?.config?.set)
          await window.operator.config.set('workspace', next);
        setSaveError(null);
      })
      .catch(() =>
        setSaveError(
          'Local changes could not be saved. Keep this window open and check disk access before restarting.',
        ),
      );
  }, []);
  useEffect(() => {
    if (!ready || data.seeded || !snapshot.hydrated) return;
    update((d) => ({
      ...d,
      seeded: true,
      readIds: Object.fromEntries(
        (snapshot.conversations || []).map((c) => [c.number, inboundIds(c)]),
      ),
    }));
  }, [ready, data.seeded, snapshot.hydrated, snapshot.conversations, update]);
  const nameFor = useCallback(
    (number) => data.contacts.find((c) => c.number === number)?.name || '',
    [data.contacts],
  );
  return (
    <WorkspaceContext.Provider
      value={{ data, update, ready, saveError, nameFor }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('WorkspaceProvider is required');
  return value;
}
