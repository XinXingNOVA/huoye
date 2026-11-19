import { useRef, useState, type ReactNode, type FormEvent } from 'react';
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts';
import { usePage, useTree } from './hooks';
import { descendantIds, folderPathLabel } from './model';

function Form({
  title,
  children,
  close,
  submit,
  confirm = '保存',
  danger = false
}: {
  title: string;
  children: ReactNode;
  close(): void;
  submit(): Promise<void>;
  confirm?: string;
  danger?: boolean;
}) {
  const lock = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current)
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await submit();
      close();
    } catch (e) {
      setError(String(e));
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <form className="collection-form" onSubmit={save}>
      <h2>{title}</h2>
      <fieldset disabled={busy}>{children}</fieldset>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={close} disabled={busy}>取消</button>
        <button className={danger ? 'collection-danger' : 'collection-primary'} disabled={busy}>
          {busy ? '正在保存…' : confirm}
        </button>
      </footer>
    </form>
  );
}

export function editGroup(
  host: UiHost,
  id?: string,
  title = '',
  members: string[] = [],
  parent: string | null = null
) {
  host.showDialog(close => (
    <Edit host={host} close={close} id={id} initial={title} members={members} initialParent={parent} />
  ));
}

function Edit({
  host,
  close,
  id,
  initial,
  members,
  initialParent
}: {
  host: UiHost;
  close(): void;
  id?: string;
  initial: string;
  members: string[];
  initialParent: string | null;
}) {
  const [title, setTitle] = useState(initial);
  const [parent, setParent] = useState<string>(initialParent ?? '');
  const tree = useTree(host, !id);
  const nodes = tree.data?.nodes ?? [];

  return (
    <Form
      title={id ? '重命名组' : initialParent ? '新建子文件夹' : '新建组'}
      close={close}
      submit={async () => {
        const result = (await host.core.run(
          'collection',
          id ? 'rename' : 'create',
          id
            ? { id, title }
            : { title, ids: members, ...(parent ? { parent } : {}) }
        )) as { id: string };
        if (!id)
          host.openTab('collection.browser', { group: result.id });
      }}
    >
      <label>
        组名
        <input
          aria-label="组名"
          autoFocus
          required
          maxLength={200}
          placeholder="输入文件夹／组名称…"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
      </label>
      {!id && nodes.length > 0 && (
        <label className="collection-form-field">
          上级位置
          <select
            aria-label="上级文件夹"
            value={parent}
            onChange={e => setParent(e.target.value)}
          >
            <option value="">顶层根目录</option>
            {nodes.map(n => (
              <option key={n.id} value={n.id}>
                {folderPathLabel(nodes, n.id)}
              </option>
            ))}
          </select>
        </label>
      )}
      {members.length > 0 && (
        <p>同时将选中的 {members.length} 项移到新组。原文件和附加信息保留。</p>
      )}
    </Form>
  );
}

export function moveFolderDialog(
  host: UiHost,
  id: string,
  title: string,
  currentParent: string | null
) {
  host.showDialog(close => (
    <MoveFolder host={host} close={close} id={id} title={title} currentParent={currentParent} />
  ));
}

function MoveFolder({
  host,
  close,
  id,
  title,
  currentParent
}: {
  host: UiHost;
  close(): void;
  id: string;
  title: string;
  currentParent: string | null;
}) {
  const [selected, setSelected] = useState<string>(currentParent ?? '');
  const [text, setText] = useState('');
  const tree = useTree(host);
  const nodes = tree.data?.nodes ?? [];
  const forbidden = new Set(descendantIds(nodes, id));
  const keyword = text.trim().toLowerCase();
  const candidates = nodes.filter(
    n => !forbidden.has(n.id) && (!keyword || folderPathLabel(nodes, n.id).toLowerCase().includes(keyword))
  );

  return (
    <Form
      title={`移动「${title}」所在层级`}
      close={close}
      confirm="确认移动"
      submit={async () => {
        const target = selected || null;
        await host.core.run('collection', 'setParent', { id, parent: target });
        host.notify(target ? '已移动到上级文件夹，可以撤销' : '已移回顶层根目录，可以撤销');
      }}
    >
      <p>可将该文件夹放入其他文件夹下作为子文件夹，或移回顶层根目录。</p>
      <input
        type="search"
        aria-label="查找目标文件夹"
        placeholder="搜索文件夹名称…"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className="collection-choices">
        <label>
          <input
            type="radio"
            name="parentFolder"
            value=""
            checked={selected === ''}
            onChange={() => setSelected('')}
          />
          <span>📁 顶层根目录</span>
        </label>
        {candidates.map(n => (
          <label key={n.id}>
            <input
              type="radio"
              name="parentFolder"
              value={n.id}
              checked={selected === n.id}
              onChange={() => setSelected(n.id)}
            />
            <span>📁 {folderPathLabel(nodes, n.id)}</span>
          </label>
        ))}
      </div>
    </Form>
  );
}

export function deleteGroup(host: UiHost, id: string, title: string) {
  host.showDialog(close => (
    <Form
      title={`删除组「${title}」`}
      close={close}
      confirm="删除组"
      danger
      submit={async () => {
        await host.core.run('collection', 'delete', { id });
        host.notify('组已移到回收站，成员保留；可以撤销');
      }}
    >
      <p>成员不会删除，会显示在“未分组”中；若有子文件夹，子文件夹仍保留在库中。</p>
      <p>恢复这个组后，尚未另行归组的成员与子文件夹会自动归回。</p>
    </Form>
  ));
}

export function chooseGroup(host: UiHost, ids: string[]) {
  host.showDialog(close => <ChooseGroup host={host} close={close} ids={ids} />);
}

function ChooseGroup({
  host,
  close,
  ids
}: {
  host: UiHost;
  close(): void;
  ids: string[];
}) {
  const [text, setText] = useState(''), [selected, setSelected] = useState(''), list = usePage(host, 'collection.list', { text });
  const tree = useTree(host);
  const nodes = tree.data?.nodes ?? [];
  return (
    <Form
      title={`移动 ${ids.length} 项素材`}
      close={close}
      confirm="移动到组"
      submit={async () => {
        if (!selected)
          throw new Error('请选择一个组');
        await host.core.run('collection', 'move', { ids, group: selected });
        host.notify('已移动，可以撤销');
      }}
    >
      <p>每项素材只属于一个组；这次操作会替换原来的归属。</p>
      <input
        type="search"
        aria-label="查找组"
        placeholder="查找组名…"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className="collection-choices">
        {list.data?.items.map(row => {
          const fullPath = nodes.length ? folderPathLabel(nodes, row.id) : '';
          return (
            <label key={row.id}>
              <input
                type="radio"
                name="group"
                value={row.id}
                checked={selected === row.id}
                onChange={() => setSelected(row.id)}
              />
              <span>{fullPath && fullPath !== row.title ? `${fullPath}` : row.title}</span>
            </label>
          );
        })}
      </div>
      <Pager list={list} />
      {list.error && <p role="alert">{list.error}</p>}
      {!list.loading && !list.data?.items.length && (
        <p>没有匹配的组。可先从右键菜单“新建组并移入”。</p>
      )}
    </Form>
  );
}

export function addMembers(host: UiHost, group: string) {
  host.showDialog(close => <AddMembers host={host} group={group} close={close} />);
}

function AddMembers({
  host,
  group,
  close
}: {
  host: UiHost;
  group: string;
  close(): void;
}) {
  const [text, setText] = useState(''), [selected, setSelected] = useState<string[]>([]), list = usePage(host, 'collection.members', { group: null, text });
  return (
    <Form
      title="从未分组中添加"
      close={close}
      confirm={`添加 ${selected.length} 项`}
      submit={async () => {
        if (!selected.length)
          throw new Error('请选择素材');
        await host.core.run('collection', 'move', { ids: selected, group });
      }}
    >
      <p>其他组的素材可在原视图选中后，使用“移动到组”。每次最多 100 项。</p>
      <input
        type="search"
        aria-label="查找未分组素材"
        placeholder="搜索素材…"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div className="collection-choices">
        {list.data?.items.map(row => (
          <label key={row.id}>
            <input
              type="checkbox"
              checked={selected.includes(row.id)}
              onChange={e =>
                setSelected(old =>
                  e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id)
                )
              }
            />
            {row.title}
          </label>
        ))}
      </div>
      <Pager list={list} />
      {list.error && <p role="alert">{list.error}</p>}
    </Form>
  );
}

export function Pager({ list }: { list: ReturnType<typeof usePage> }) {
  return (
    <div className="collection-pagination">
      <button type="button" disabled={!list.hasPrev || list.loading} onClick={list.prev}>
        上一页
      </button>
      <span>{list.loading ? '读取中…' : `${list.data?.total ?? 0} 项`}</span>
      <button type="button" disabled={!list.data?.nextCursor || list.loading} onClick={list.next}>
        下一页
      </button>
    </div>
  );
}
