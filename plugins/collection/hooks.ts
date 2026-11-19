import { useEffect, useState } from 'react';
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts';
import type { Page, Summary, TreeData } from './model';

export function usePage(host: UiHost, query: string, args: Record<string, unknown>, active = true) {
  const key = JSON.stringify([query, args]), [cursor, setCursor] = useState<string | undefined>(), [back, setBack] = useState<(string | undefined)[]>([]);
  const [tick, setTick] = useState(0), [state, setState] = useState<{
    key: string;
    data?: Page;
    error?: string;
    loading: boolean;
  }>({ key, loading: true });
  useEffect(() => {
    if (active) {
      setCursor(undefined);
      setBack([]);
    }
  }, [key, active]);
  useEffect(() => {
    if (!active)
      return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setCursor(undefined);
        setBack([]);
        setTick(n => n + 1);
      }, 100);
    };
    const offChanged = host.core.on('changed', schedule);
    const offList = host.core.on('listChanged', schedule);
    return () => {
      offChanged();
      offList();
      clearTimeout(timer);
    };
  }, [host, active]);
  useEffect(() => {
    if (!active)
      return;
    let alive = true;
    setState(s => ({ key, loading: true, ...(s.key === key ? { data: s.data } : {}) }));
    const [name, input] = JSON.parse(key);
    void host.core.executeQuery({ query: name, args: input, limit: 20, ...(cursor ? { cursor } : {}) }).then(
      r => {
        if (alive)
          setState({ key, data: r.result as unknown as Page, loading: false });
      },
      e => {
        if (alive)
          setState({ key, error: String(e), loading: false });
      }
    );
    return () => {
      alive = false;
    };
  }, [host, key, cursor, tick, active]);
  return {
    ...(state.key === key ? state : { loading: true, data: undefined, error: undefined }),
    next: () => {
      if (state.data?.nextCursor) {
        setBack(s => [...s, cursor]);
        setCursor(state.data.nextCursor);
      }
    },
    prev: () => {
      setCursor(back.at(-1));
      setBack(s => s.slice(0, -1));
    },
    hasPrev: back.length > 0,
    refresh: () => {
      setCursor(undefined);
      setBack([]);
      setTick(n => n + 1);
    }
  };
}

export function useSummary(host: UiHost, id: string) {
  const [state, setState] = useState<{
    id: string;
    data?: Summary;
    error?: string;
  }>({ id });
  useEffect(() => {
    let alive = true, serial = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const n = ++serial;
      void host.core.executeQuery({ query: 'collection.summary', args: { id } }).then(
        r => {
          if (alive && n === serial)
            setState({ id, data: r.result as unknown as Summary });
        },
        e => {
          if (alive && n === serial)
            setState({ id, error: String(e) });
        }
      );
    };
    refresh();
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 100);
    };
    const offChanged = host.core.on('changed', schedule);
    const offList = host.core.on('listChanged', schedule);
    return () => {
      alive = false;
      offChanged();
      offList();
      clearTimeout(timer);
    };
  }, [host, id]);
  return state.id === id ? state : { id };
}

export function useTree(host: UiHost, active = true) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{
    data?: TreeData;
    error?: string;
    loading: boolean;
  }>({ loading: true });

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick(n => n + 1), 100);
    };
    const offChanged = host.core.on('changed', schedule);
    const offList = host.core.on('listChanged', schedule);
    return () => {
      offChanged();
      offList();
      clearTimeout(timer);
    };
  }, [host, active]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setState(s => ({ ...s, loading: true, error: undefined }));
    void host.core.executeQuery({ query: 'collection.tree', args: {} }).then(
      r => {
        if (alive)
          setState({ data: r.result as unknown as TreeData, loading: false });
      },
      e => {
        if (alive)
          setState({ error: String(e), loading: false });
      }
    );
    return () => {
      alive = false;
    };
  }, [host, tick, active]);

  return {
    ...state,
    refresh: () => setTick(n => n + 1)
  };
}

export function useUngroupedIds(host: UiHost, enabled: boolean) {
  const [ids, setIds] = useState<string[] | undefined>();
  useEffect(() => {
    if (!enabled) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const collected: string[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 40; page++) {
          const res = await host.core.executeQuery({
            query: 'collection.members',
            args: { group: null, text: '' },
            limit: 50,
            ...(cursor ? { cursor } : {})
          });
          const data = res.result as unknown as Page;
          for (const item of data.items) collected.push(item.id);
          if (!data.nextCursor) break;
          cursor = data.nextCursor;
        }
        if (alive) setIds(collected);
      } catch {
        // 保持上次有效范围
      }
    };
    void load();
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 120);
    };
    const offChanged = host.core.on('changed', schedule);
    const offList = host.core.on('listChanged', schedule);
    return () => {
      alive = false;
      offChanged();
      offList();
      clearTimeout(timer);
    };
  }, [host, enabled]);
  return ids;
}

