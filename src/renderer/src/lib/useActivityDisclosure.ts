import { useState } from 'react';
import { useStore } from '../store';

// React adaptation of codex-webui's savedActivityItemExpansion /
// savedActivityGroupExpansion and explicit open/closed localStorage values.
// Attribution and license: ../vendor/codex-webui/LICENSE.
export function useActivityDisclosure(kind: 'group' | 'item', anchor: string): [boolean | null, (open: boolean) => void] {
  const threadId = useStore(state => state.activeThreadId);
  const key = 'codex.activity.' + kind + ':' + threadId + ':' + anchor;
  const read = () => {
    try {
      const saved = localStorage.getItem(key);
      return saved === 'open' ? true : saved === 'closed' ? false : null;
    } catch { return null; }
  };
  const [state, setState] = useState<{ key: string; open: boolean | null }>(() => ({ key, open: read() }));
  return [state.key === key ? state.open : read(), open => {
    setState({ key, open });
    try { localStorage.setItem(key, open ? 'open' : 'closed'); } catch { /* Optional UI preference. */ }
  }];
}
