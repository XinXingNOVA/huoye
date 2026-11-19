import { createContext, useCallback, useContext, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { UiPlugin, UiHost, ViewProps, TabProps, NavProps } from '@resource-manager/plugin-api/ui/contracts';
import {
  ResourceCollection,
  collectionQuery,
  type CollectionParams,
  type CollectionState,
  type CollectionToolbarProps
} from '@resource-manager/plugin-api/ui/collection';
import type { Query } from '@resource-manager/plugin-api/query';
import { useEntityState } from '@resource-manager/plugin-api/ui/data';
import { ResourceCover } from '@resource-manager/plugin-api/ui/media';
import { usePluginState } from '@resource-manager/plugin-api/ui/local-state';
import { useSummary, useTree, useUngroupedIds } from './hooks';
import {
  ancestorChain,
  descendantIds,
  folderPathLabel,
  groupQuery,
  membersQuery,
  multiMembersQuery,
  type TreeNode
} from './model';
import { addMembers, chooseGroup, deleteGroup, editGroup, moveFolderDialog } from './dialogs';
import './style.css';

const HOME = 'collection.home', UNASSIGNED = 'collection.ungrouped';
const FOLDER_DRAG_MIME = 'application/x-rm-collection-folder';

function extractDraggedFolders(dt: DataTransfer, host: UiHost, folderIds: ReadonlySet<string>): { folderIds: string[]; viaMime: boolean } {
  const draggedFolder = dt.getData(FOLDER_DRAG_MIME);
  if (draggedFolder) return { folderIds: [draggedFolder], viaMime: true };
  const droppedIds = host.idsFromDrop(dt);
  if (droppedIds.length > 0 && droppedIds.every(id => folderIds.has(id))) {
    return { folderIds: droppedIds, viaMime: false };
  }
  return { folderIds: [], viaMime: false };
}

const openHome = (host: UiHost) => host.openTab('collection.browser', { title: '全部文件夹' });
const openFolder = (host: UiHost, groupId: string, title?: string) =>
  host.openTab('collection.browser', title ? { group: groupId, title } : { group: groupId });

function Folder({ open = false }: { open?: boolean }) {
  return open ? (
    <svg width="28" height="24" viewBox="0 0 28 24" fill="none" aria-hidden="true">
      <path d="M2 6V3h9l3 3h10v3H6.5L3 19.5V6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M3 20.5 6.8 10h19.2l-3.4 10.5H3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="28" height="24" viewBox="0 0 28 24" fill="none" aria-hidden="true">
      <path d="M2 6V3h9l3 3h12v15H2V6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function FolderSmallIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className="collection-tree-icon" width="15" height="14" viewBox="0 0 28 24" fill="none" aria-hidden="true">
      {open ? (
        <>
          <path d="M2 6V3h9l3 3h10v3H6.5L3 19.5V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M3 20.5 6.8 10h19.2l-3.4 10.5H3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </>
      ) : (
        <path d="M2 6V3h9l3 3h12v15H2V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function Cover({ view, host }: ViewProps) {
  const { data, error } = useSummary(host, view.id), asset = useEntityState(data?.coverId ?? undefined).view;
  const parentId = typeof view.blocks.collection?.data.parent === 'string' ? view.blocks.collection.data.parent : undefined;
  const parentView = useEntityState(parentId).view;
  const parentTitle = parentView && !parentView.deletedAt && parentView.blocks.collection
    ? String(parentView.blocks.collection.data.title ?? '')
    : '';
  const folderTitle = String(view.blocks.collection?.data.title ?? '文件夹');
  return (
    <div
      className="collection-cover"
      data-drop-zone={!view.deletedAt ? view.id : undefined}
      data-drop-title={!view.deletedAt ? folderTitle : undefined}
    >
      <div className="collection-cover-label">
        <Folder />
        <span>{parentTitle ? `${parentTitle} ／ 文件夹` : '文件夹'}</span>
      </div>
      <div className="collection-cover-art">
        {asset && !asset.deletedAt && !asset.blocks.collection ? <ResourceCover host={host} view={asset} /> : <Folder />}
      </div>
      <div className="collection-cover-count">
        {error ? '文件夹暂不可用' : data ? (data.count ? `${data.count} 项成员` : '空文件夹 · 0 项') : '读取中…'}
      </div>
    </div>
  );
}

function SubfolderCard({
  node,
  host,
  folderIds,
  onDropFolder
}: {
  node: TreeNode;
  host: UiHost;
  folderIds: ReadonlySet<string>;
  onDropFolder(folderId: string, targetParent: string): void;
}) {
  const { data } = useSummary(host, node.id);
  const asset = useEntityState(data?.coverId ?? node.coverId ?? undefined).view;
  const [dropActive, setDropActive] = useState(false);

  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const action = await host.contextMenu([
      { id: 'open', label: '打开子文件夹' },
      { id: 'newSub', label: '新建下级文件夹…' },
      { id: 'rename', label: '重命名…' },
      { id: 'move', label: '移动所在层级…' },
      { id: 'toRoot', label: '移回顶层根目录' },
      { type: 'separator' },
      { id: 'delete', label: '删除文件夹（成员保留）', danger: true }
    ]);
    if (action === 'open') openFolder(host, node.id, node.title);
    if (action === 'newSub') editGroup(host, undefined, '', [], node.id);
    if (action === 'rename') editGroup(host, node.id, node.title, [], node.parent);
    if (action === 'move') moveFolderDialog(host, node.id, node.title, node.parent);
    if (action === 'toRoot') {
      void host.core.run('collection', 'setParent', { id: node.id, parent: null }).catch(err => host.notify(String(err)));
    }
    if (action === 'delete') deleteGroup(host, node.id, node.title);
  };

  return (
    <div
      className={`collection-subfolder-card${dropActive ? ' is-drop-target' : ''}`}
      data-subfolder-id={node.id}
      data-drop-zone={node.id}
      data-drop-title={node.title}
      draggable
      onDragStart={e => {
        e.stopPropagation();
        e.dataTransfer.setData(FOLDER_DRAG_MIME, node.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={e => {
        if (e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) {
          e.preventDefault();
          e.stopPropagation();
          setDropActive(true);
        }
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDropActive(false);
      }}
      onDrop={e => {
        setDropActive(false);
        const dragged = extractDraggedFolders(e.dataTransfer, host, folderIds);
        if (dragged.folderIds.length) {
          e.preventDefault();
          if (dragged.viaMime) e.stopPropagation();
          for (const id of dragged.folderIds) if (id !== node.id) onDropFolder(id, node.id);
        }
      }}
      onClick={() => openFolder(host, node.id, node.title)}
      onContextMenu={e => void onContextMenu(e)}
    >
      <div className="collection-subfolder-thumb">
        {asset && !asset.deletedAt && !asset.blocks.collection ? (
          <ResourceCover host={host} view={asset} />
        ) : (
          <Folder />
        )}
      </div>
      <div className="collection-subfolder-meta">
        <strong className="collection-subfolder-title" title={node.title}>{node.title}</strong>
        <span className="collection-subfolder-sub">
          {node.totalCount} 项{node.childCount > 0 ? ` · ${node.childCount} 个子文件夹` : ''}
        </span>
      </div>
    </div>
  );
}

function FolderTreeNav({ host, activeTab }: NavProps) {
  const tree = useTree(host, true);
  const nodes = tree.data?.nodes ?? [];
  const folderIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);
  const ungroupedCount = tree.data?.ungroupedCount ?? 0;
  const sectionCollapse = usePluginState<boolean>(host, 'collection', 'section-collapsed', false);
  const sectionCollapsed = sectionCollapse.value === true;
  const collapse = usePluginState<string[]>(host, 'collection', 'tree-collapsed', [], {
    legacyKey: `collection:tree-collapsed:${host.root}`
  });
  const collapsed = Array.isArray(collapse.value) ? collapse.value.filter(x => typeof x === 'string') : [];
  const [dropTarget, setDropTarget] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();

  const isBrowserTab = activeTab?.type === 'collection.browser';
  const activeGroup = isBrowserTab && typeof activeTab?.params.group === 'string' ? activeTab.params.group : undefined;
  const activeUngrouped = isBrowserTab && !activeGroup && (activeTab?.params.ungrouped === true || activeTab?.params.presetId === UNASSIGNED);
  const activeHome = isBrowserTab && !activeGroup && !activeUngrouped;

  const toggleCollapse = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter(x => x !== id) : [...collapsed, id];
    void collapse.set(next).catch(e => host.notify(String(e)));
  };

  const childrenByParent = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    const key = n.parent ?? '';
    const list = childrenByParent.get(key) ?? [];
    list.push(n);
    childrenByParent.set(key, list);
  }

  const moveAssets = async (ids: string[], targetGroup: string | null, label: string) => {
    try {
      await host.core.run('collection', 'move', { ids, group: targetGroup });
      host.notify(targetGroup ? `已移入「${label}」` : '已移出文件夹');
    } catch (e) {
      host.notify(String(e));
    }
  };

  const reparentFolder = async (folderId: string, targetParent: string | null) => {
    if (folderId === targetParent) return;
    try {
      await host.core.run('collection', 'setParent', { id: folderId, parent: targetParent });
      if (targetParent && collapsed.includes(targetParent))
        toggleCollapse(targetParent);
      host.notify(targetParent ? '已移动文件夹层级' : '已移回顶层目录');
    } catch (e) {
      host.notify(String(e));
    }
  };

  const openNodeMenu = async (node: TreeNode) => {
    const action = await host.contextMenu([
      { id: 'open', label: '打开文件夹' },
      { id: 'newSub', label: '新建子文件夹…' },
      { id: 'rename', label: '重命名…' },
      { id: 'move', label: '移动所在层级…' },
      ...(node.parent ? [{ id: 'toRoot', label: '移回顶层根目录' }] : []),
      { type: 'separator' },
      { id: 'delete', label: '删除文件夹（成员保留）', danger: true }
    ]);
    if (action === 'open') openFolder(host, node.id, node.title);
    if (action === 'newSub') editGroup(host, undefined, '', [], node.id);
    if (action === 'rename') setRenaming({ id: node.id, title: node.title });
    if (action === 'move') moveFolderDialog(host, node.id, node.title, node.parent);
    if (action === 'toRoot') void reparentFolder(node.id, null);
    if (action === 'delete') deleteGroup(host, node.id, node.title);
  };

  const commitInlineRename = async () => {
    if (!renaming) return;
    const nextTitle = renaming.title.trim();
    const targetId = renaming.id;
    setRenaming(undefined);
    if (!nextTitle) return;
    try {
      await host.core.run('collection', 'rename', { id: targetId, title: nextTitle });
    } catch (e) {
      host.notify(String(e));
    }
  };

  const renderBranch = (parentKey: string, depth = 0, seen = new Set<string>()): React.ReactNode => {
    const items = (childrenByParent.get(parentKey) ?? []).filter(n => !seen.has(n.id));
    if (!items.length) return null;
    return items.map(node => {
      const hasChildren = (childrenByParent.get(node.id)?.length ?? 0) > 0;
      const isCollapsed = collapsed.includes(node.id);
      const nextSeen = new Set(seen);
      nextSeen.add(node.id);
      return (
        <div key={node.id} className="collection-tree-node" data-folder-node={node.id}>
          <div
            className={`nav-item view-item collection-tree-row${activeGroup === node.id ? ' active' : ''}${dropTarget === node.id ? ' is-drop-target' : ''}`}
            data-drop-zone={node.id}
            data-drop-title={node.title}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            draggable={renaming?.id !== node.id}
            onDragStart={e => {
              e.stopPropagation();
              e.dataTransfer.setData(FOLDER_DRAG_MIME, node.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setDropTarget(undefined)}
            onDragOver={e => {
              if (e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) {
                e.preventDefault();
                e.stopPropagation();
                setDropTarget(node.id);
              }
            }}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                setDropTarget(undefined);
            }}
            onDrop={e => {
              setDropTarget(undefined);
              const dragged = extractDraggedFolders(e.dataTransfer, host, folderIds);
              if (dragged.folderIds.length) {
                e.preventDefault();
                if (dragged.viaMime) e.stopPropagation();
                for (const id of dragged.folderIds) if (id !== node.id) void reparentFolder(id, node.id);
              }
            }}
            onContextMenu={e => {
              e.preventDefault();
              e.stopPropagation();
              void openNodeMenu(node);
            }}
          >
            {hasChildren ? (
              <button
                type="button"
                className="collection-tree-chevron"
                aria-label={isCollapsed ? `展开 ${node.title}` : `折叠 ${node.title}`}
                aria-expanded={!isCollapsed}
                disabled={!collapse.ready || collapse.busy}
                onClick={e => {
                  e.stopPropagation();
                  toggleCollapse(node.id);
                }}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
            ) : (
              <span className="collection-tree-chevron-spacer" />
            )}
            {renaming?.id === node.id ? (
              <input
                className="name-input nav-input collection-tree-rename"
                autoFocus
                value={renaming.title}
                onChange={e => setRenaming({ id: node.id, title: e.target.value })}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === 'Enter') void commitInlineRename();
                  else if (e.key === 'Escape') setRenaming(undefined);
                }}
                onBlur={() => void commitInlineRename()}
              />
            ) : (
              <button
                type="button"
                className="nav-label collection-tree-label"
                title={`${folderPathLabel(nodes, node.id)}（拖入素材可归档，双击改名）`}
                onClick={() => openFolder(host, node.id, node.title)}
                onDoubleClick={() => setRenaming({ id: node.id, title: node.title })}
              >
                <FolderSmallIcon open={hasChildren && !isCollapsed} />
                <span className="collection-tree-text">{node.title}</span>
              </button>
            )}
            <span className="collection-tree-count" title={hasChildren ? `本层 ${node.count} 项 · 含子文件夹共 ${node.totalCount} 项` : `${node.count} 项`}>
              {hasChildren ? node.totalCount : node.count}
            </span>
            <button
              type="button"
              className="nav-x collection-tree-add-sub"
              title={`在「${node.title}」下新建子文件夹`}
              aria-label={`在「${node.title}」下新建子文件夹`}
              onClick={e => {
                e.stopPropagation();
                editGroup(host, undefined, '', [], node.id);
              }}
            >
              ＋
            </button>
          </div>
          {hasChildren && !isCollapsed && (
            <div className="collection-tree-children">
              {renderBranch(node.id, depth + 1, nextSeen)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div
      className="nav-group collection-sidebar-tree"
      onKeyDown={e => {
        if ((e.target as Element).matches('input'))
          e.stopPropagation();
      }}
    >
      <div
        className={`nav-title${dropTarget === '$root' ? ' is-drop-target' : ''}`}
        onDragOver={e => {
          if (e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget('$root');
          }
        }}
        onDragLeave={() => setDropTarget(undefined)}
        onDrop={e => {
          setDropTarget(undefined);
          const draggedFolder = e.dataTransfer.getData(FOLDER_DRAG_MIME);
          if (draggedFolder) {
            e.preventDefault();
            e.stopPropagation();
            void reparentFolder(draggedFolder, null);
          }
        }}
      >
        <button
          type="button"
          className="collection-section-toggle"
          aria-expanded={!sectionCollapsed}
          title={sectionCollapsed ? '展开文件夹目录' : '折叠文件夹目录'}
          onClick={() => void sectionCollapse.set(!sectionCollapsed).catch(e => host.notify(String(e)))}
        >
          <span className="collection-section-chevron">{sectionCollapsed ? '▸' : '▾'}</span>
          <span>文件夹</span>
        </button>
        <button
          className="nav-add"
          title="新建文件夹"
          aria-label="新建文件夹"
          onClick={() => {
            if (sectionCollapsed) void sectionCollapse.set(false).catch(() => {});
            editGroup(host);
          }}
        >
          ＋
        </button>
      </div>
      {!sectionCollapsed && (
        <>
          {collapse.error && <p className="nav-hint" role="alert">{collapse.error}</p>}
          <div className={`nav-item view-item collection-tree-row${activeHome ? ' active' : ''}`}>
            <span className="collection-tree-chevron-spacer" />
            <button
              type="button"
              className="nav-label collection-tree-label"
              title="查看全部文件夹卡片总览"
              onClick={() => openHome(host)}
            >
              <FolderSmallIcon open={false} />
              <span className="collection-tree-text">全部文件夹</span>
            </button>
            <span className="collection-tree-count">{nodes.length}</span>
          </div>
          {nodes.length > 0 ? (
            <div className="collection-tree-list">
              {renderBranch('')}
            </div>
          ) : (
            !tree.loading && (
              <button className="nav-item muted" onClick={() => editGroup(host)}>
                ＋ 新建第一个文件夹…
              </button>
            )
          )}
          <div
            className={`nav-item view-item collection-tree-row collection-tree-ungrouped${activeUngrouped ? ' active' : ''}`}
            data-drop-zone="$ungrouped"
            data-drop-title="未归档素材"
            onDrop={e => {
              const dragged = extractDraggedFolders(e.dataTransfer, host, folderIds);
              if (dragged.folderIds.length) {
                e.preventDefault();
                if (dragged.viaMime) e.stopPropagation();
                return;
              }
              const droppedIds = host.idsFromDrop(e.dataTransfer).filter(id => !folderIds.has(id));
              if (droppedIds.length > 0 && droppedIds.length >= (e.dataTransfer.files?.length ?? 0)) {
                e.preventDefault();
                void moveAssets(droppedIds, null, '未归档');
              }
            }}
          >
            <span className="collection-tree-chevron-spacer" />
            <button
              type="button"
              className="nav-label collection-tree-label"
              title="查看未归入任何文件夹的素材（拖到这里可移出文件夹）"
              onClick={() => host.openTab('collection.browser', { ungrouped: true, title: '未归档素材' })}
            >
              <span className="collection-tree-text muted">未归档素材</span>
            </button>
            <span className="collection-tree-count">{ungroupedCount}</span>
          </div>
        </>
      )}
    </div>
  );
}

function GroupTitle({ params }: { params: Record<string, unknown> }) {
  const group = typeof params.group === 'string' ? params.group : undefined, view = useEntityState(group).view;
  return (
    <>
      {group
        ? String(view?.blocks.collection?.data.title ?? params.title ?? '文件夹')
        : params.presetId === UNASSIGNED || params.ungrouped
          ? '未归档素材'
          : '全部文件夹'}
    </>
  );
}

interface FolderBarContextValue {
  home: boolean;
  ungrouped: boolean;
  group?: string;
  valid: boolean;
  title: string;
  folderTags: string[];
  folderIds: ReadonlySet<string>;
  parentAncestors: TreeNode[];
  currentNode?: TreeNode;
  subfolders: TreeNode[];
  includeSubfolders: boolean;
  hideEmpty: boolean;
  crumbDrop?: string;
  setCrumbDrop(key: string | undefined): void;
  onToggleRecursive(checked: boolean): void;
  onToggleHideEmpty(checked: boolean): void;
  run(command: string, args: Record<string, unknown>): Promise<void>;
}

const FolderBarContext = createContext<FolderBarContextValue | null>(null);

function FolderSubbar({ host, selected }: CollectionToolbarProps) {
  const ctx = useContext(FolderBarContext);
  if (!ctx) return null;
  const {
    home,
    ungrouped,
    group,
    valid,
    title,
    folderTags,
    folderIds,
    parentAncestors,
    currentNode,
    subfolders,
    includeSubfolders,
    hideEmpty,
    crumbDrop,
    setCrumbDrop,
    onToggleRecursive,
    onToggleHideEmpty,
    run
  } = ctx;

  const breadcrumbDropProps = (targetGroupId: string | null, key: string) => ({
    ...(targetGroupId ? { 'data-drop-zone': targetGroupId } : {}),
    onDragOver(e: DragEvent) {
      if (e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) {
        e.preventDefault();
        e.stopPropagation();
        setCrumbDrop(key);
      }
    },
    onDragLeave() {
      setCrumbDrop(undefined);
    },
    onDrop(e: DragEvent) {
      setCrumbDrop(undefined);
      const dragged = extractDraggedFolders(e.dataTransfer, host, folderIds);
      if (dragged.folderIds.length) {
        e.preventDefault();
        if (dragged.viaMime) e.stopPropagation();
        for (const id of dragged.folderIds) if (id !== targetGroupId) void run('setParent', { id, parent: targetGroupId });
      }
    }
  });

  const openFolderActionsMenu = async () => {
    if (!group || !valid) return;
    const action = await host.contextMenu([
      { id: 'add', label: '添加素材…' },
      { id: 'newSub', label: '新建子文件夹…' },
      { id: 'rename', label: '重命名文件夹…' },
      { id: 'move', label: '移动所在层级…' },
      ...(currentNode?.parent ? [{ id: 'toRoot', label: '移回顶层根目录' }] : []),
      { id: 'autoCover', label: '恢复自动封面' },
      { type: 'separator' },
      { id: 'delete', label: '删除文件夹（保留素材）…', danger: true }
    ]);
    if (action === 'add') addMembers(host, group);
    if (action === 'newSub') editGroup(host, undefined, '', [], group);
    if (action === 'rename') editGroup(host, group, title, [], currentNode?.parent ?? null);
    if (action === 'move') moveFolderDialog(host, group, title, currentNode?.parent ?? null);
    if (action === 'toRoot') void run('setParent', { id: group, parent: null });
    if (action === 'autoCover') void run('setCover', { id: group, assetId: null });
    if (action === 'delete') deleteGroup(host, group, title);
  };

  return (
    <div className="collection-subbar">
      <div className="collection-subbar-left">
        <div className="collection-breadcrumb">
          <button
            type="button"
            className={crumbDrop === '$root' ? 'is-drop-target' : undefined}
            onClick={() => openHome(host)}
            title="点击返回全部文件夹；拖动子文件夹到此可移回根目录"
            {...breadcrumbDropProps(null, '$root')}
          >
            全部文件夹
          </button>
          {parentAncestors.map(anc => (
            <span key={anc.id} className="collection-breadcrumb-segment">
              <span>／</span>
              <button
                type="button"
                className={crumbDrop === anc.id ? 'is-drop-target' : undefined}
                data-drop-title={anc.title}
                onClick={() => openFolder(host, anc.id, anc.title)}
                title={`点击进入「${anc.title}」；将素材或子文件夹拖到此可移入该级`}
                {...breadcrumbDropProps(anc.id, anc.id)}
              >
                {anc.title}
              </button>
            </span>
          ))}
          {!home && (
            <>
              <span>／</span>
              <span className="collection-breadcrumb-current">{title}</span>
            </>
          )}
        </div>
        {folderTags.length > 0 && (
          <div className="collection-tags">
            {folderTags.map(tag => <span key={tag}>{tag}</span>)}
          </div>
        )}
      </div>

      <div className="collection-subbar-right">
        {home && (
          <>
            <label className="collection-recursive-toggle">
              <input
                type="checkbox"
                checked={hideEmpty}
                onChange={e => onToggleHideEmpty(e.target.checked)}
              />
              隐藏空文件夹
            </label>
            <button
              type="button"
              className="small"
              onClick={() => host.openTab('collection.browser', { ungrouped: true, title: '未归档素材' })}
            >
              未归档素材
            </button>
            <button type="button" className="small primary" onClick={() => editGroup(host)}>
              ＋ 新建文件夹
            </button>
          </>
        )}

        {ungrouped && (
          <>
            {selected.length > 0 && (
              <>
                <span className="collection-subbar-selected muted">已选 {selected.length} 项</span>
                <button type="button" className="small" onClick={() => chooseGroup(host, [...selected])}>
                  移入文件夹…
                </button>
              </>
            )}
            <button
              type="button"
              className="small primary"
              onClick={() => editGroup(host, undefined, '', [...selected])}
            >
              ＋ 新建文件夹{selected.length > 0 ? '并移入' : ''}
            </button>
          </>
        )}

        {group && valid && (
          <>
            {subfolders.length > 0 && (
              <label className="collection-recursive-toggle" title="开启后一并展示所有子文件夹内的素材">
                <input
                  type="checkbox"
                  checked={includeSubfolders}
                  onChange={e => onToggleRecursive(e.target.checked)}
                />
                包含子文件夹 ({currentNode?.totalCount ?? 0})
              </label>
            )}
            {selected.length > 0 && (
              <>
                <span className="collection-subbar-selected muted">已选 {selected.length} 项</span>
                <button type="button" className="small" onClick={() => chooseGroup(host, [...selected])}>
                  移动到组
                </button>
                <button type="button" className="small" onClick={() => void run('move', { ids: [...selected], group: null })}>
                  移出组
                </button>
                {selected.length === 1 && (
                  <button
                    type="button"
                    className="small"
                    onClick={() => void run('setCover', { id: group, assetId: selected[0] })}
                  >
                    设为封面
                  </button>
                )}
              </>
            )}
            <button type="button" className="small" onClick={() => editGroup(host, undefined, '', [], group)}>
              ＋ 新建子文件夹
            </button>
            <button
              type="button"
              className="small"
              aria-label="文件夹操作"
              onClick={() => void openFolderActionsMenu()}
            >
              文件夹 ⋯
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Browser(props: TabProps<CollectionParams, CollectionState>) {
  const { host, params, active, setParams, setFocus } = props;
  const group = typeof params.group === 'string' ? params.group : undefined;
  const ungrouped = !group && (params.ungrouped === true || params.presetId === UNASSIGNED);
  const home = !group && !ungrouped;
  const groupState = useEntityState(group), view = groupState.view, valid = !!view && !view.deletedAt && !!view.blocks.collection;

  const includeSubfolders = params.includeSubfolders === true;
  const hideEmpty = params.hideEmpty === true;
  const [error, setError] = useState('');
  const [crumbDrop, setCrumbDrop] = useState<string>();

  const tree = useTree(host, active);
  const treeNodes = tree.data?.nodes ?? [];
  const folderIds = useMemo(() => new Set(treeNodes.map(n => n.id)), [treeNodes]);
  const currentNode = group ? treeNodes.find(n => n.id === group) : undefined;
  const subfolders = useMemo(() => (group ? treeNodes.filter(n => n.parent === group) : []), [group, treeNodes]);
  const ancestors = useMemo(() => (group ? ancestorChain(treeNodes, group) : []), [group, treeNodes]);
  const parentAncestors = useMemo(() => (ancestors.length > 1 ? ancestors.slice(0, -1) : []), [ancestors]);
  const effectiveRecursive = !!group && includeSubfolders && subfolders.length > 0;
  const recursiveTargets = useMemo(
    () => (effectiveRecursive && group ? descendantIds(treeNodes, group) : group ? [group] : []),
    [effectiveRecursive, group, treeNodes]
  );

  const ungroupedIds = useUngroupedIds(host, active && ungrouped);
  const nonEmptyFolderIds = useMemo(
    () => (home && hideEmpty ? treeNodes.filter(n => n.totalCount > 0).map(n => n.id) : undefined),
    [home, hideEmpty, treeNodes]
  );

  const title = home
    ? '全部文件夹'
    : ungrouped
      ? '未归档素材'
      : String(view?.blocks.collection?.data.title ?? params.title ?? '文件夹');

  useEffect(() => {
    if (params.title !== title) setParams({ ...params, title });
  }, [params, setParams, title]);

  const baseQuery = useMemo<Query>(() => {
    if (home) return groupQuery;
    if (ungrouped) return { lacks: ['collection'] };
    if (effectiveRecursive) return multiMembersQuery(recursiveTargets);
    return membersQuery(group!);
  }, [home, ungrouped, effectiveRecursive, recursiveTargets, group]);

  const effectiveParams = useMemo<CollectionParams>(
    () => ({
      ...params,
      title,
      query: baseQuery
    }),
    [params, title, baseQuery]
  );

  const handleSetParams = useCallback(
    (next: CollectionParams) => {
      setParams({
        ...next,
        ...(group !== undefined ? { group } : {}),
        ...(ungrouped ? { ungrouped: true } : {}),
        ...(includeSubfolders ? { includeSubfolders: true } : {}),
        ...(hideEmpty ? { hideEmpty: true } : {})
      });
    },
    [setParams, group, ungrouped, includeSubfolders, hideEmpty]
  );

  const handleSetFocus = useCallback(
    (ids: string[]) => {
      setFocus(ids.length > 0 ? ids : valid && group ? [group] : []);
    },
    [setFocus, valid, group]
  );

  const run = useCallback(
    async (command: string, args: Record<string, unknown>) => {
      setError('');
      try {
        await host.core.run('collection', command, args);
      } catch (e) {
        setError(String(e));
      }
    },
    [host]
  );

  const onToggleRecursive = useCallback(
    (checked: boolean) => {
      setParams({ ...params, includeSubfolders: checked });
    },
    [params, setParams]
  );

  const onToggleHideEmpty = useCallback(
    (checked: boolean) => {
      setParams({ ...params, hideEmpty: checked });
    },
    [params, setParams]
  );

  const folderTags = useMemo(
    () => (valid && Array.isArray(view?.blocks.tags?.data.values) ? (view!.blocks.tags.data.values as string[]) : []),
    [valid, view]
  );

  const barCtx = useMemo<FolderBarContextValue>(
    () => ({
      home,
      ungrouped,
      group,
      valid,
      title,
      folderTags,
      folderIds,
      parentAncestors,
      currentNode,
      subfolders,
      includeSubfolders,
      hideEmpty,
      crumbDrop,
      setCrumbDrop,
      onToggleRecursive,
      onToggleHideEmpty,
      run
    }),
    [
      home,
      ungrouped,
      group,
      valid,
      title,
      folderTags,
      folderIds,
      parentAncestors,
      currentNode,
      subfolders,
      includeSubfolders,
      hideEmpty,
      crumbDrop,
      onToggleRecursive,
      onToggleHideEmpty,
      run
    ]
  );

  if (group && !valid) {
    return (
      <section className="collection-page" data-collection-page={group}>
        <div className="collection-empty">
          <Folder />
          <h2>{groupState.status === 'loading' ? '正在读取文件夹…' : '这个文件夹已删除或不可用'}</h2>
          <p>成员仍在仓库中。可到“未归档素材”查看，或在回收站恢复这个文件夹。</p>
          <button onClick={() => host.openTab('collection.browser', { ungrouped: true })}>查看未归档素材</button>
        </div>
      </section>
    );
  }

  const beforeItems = (
    <>
      {error && (
        <div className="collection-error" role="alert">
          <span>{error}</span>
          <button className="small" onClick={() => setError('')}>关闭</button>
        </div>
      )}
      {group && valid && subfolders.length > 0 && (
        <section className="collection-subfolders" aria-label="子文件夹">
          <div className="collection-subfolders-head">
            <span className="collection-subfolders-title">子文件夹 ({subfolders.length})</span>
            <span className="collection-subfolders-hint">点击进入，或将下方素材卡片拖入子文件夹归档</span>
          </div>
          <div className="collection-subfolders-grid">
            {subfolders.map(sub => (
              <SubfolderCard
                key={sub.id}
                node={sub}
                host={host}
                folderIds={folderIds}
                onDropFolder={(folderId, targetParent) => void run('setParent', { id: folderId, parent: targetParent })}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );

  const scopeIds = ungrouped ? (ungroupedIds ?? []) : home && hideEmpty ? nonEmptyFolderIds : undefined;

  return (
    <div
      className="collection-surface-host"
      data-collection-page={home ? 'home' : ungrouped ? 'ungrouped' : group}
      style={{ display: 'contents' }}
    >
      <FolderBarContext.Provider value={barCtx}>
        <ResourceCollection
          {...props}
          params={effectiveParams}
          setParams={handleSetParams}
          setFocus={handleSetFocus}
          scopeIds={scopeIds}
          Toolbar={FolderSubbar}
          beforeItems={beforeItems}
        />
      </FolderBarContext.Provider>
    </div>
  );
}

function FolderInfoSection({ view, host }: ViewProps) {
  const tree = useTree(host);
  const nodes = tree.data?.nodes ?? [];
  const node = nodes.find(n => n.id === view.id);
  const title = String(view.blocks.collection?.data.title ?? '文件夹');
  const parentId = typeof view.blocks.collection?.data.parent === 'string' ? view.blocks.collection.data.parent : null;
  const chain = ancestorChain(nodes, view.id);
  const parentChain = chain.length > 1 ? chain.slice(0, -1) : [];

  return (
    <div className="collection-membership">
      <span className="collection-membership-path">
        <span className="muted">位置：</span>
        <button type="button" className="collection-path-link" onClick={() => openHome(host)}>
          根目录
        </button>
        {parentChain.map(anc => (
          <span key={anc.id}>
            {' ／ '}
            <button type="button" className="collection-path-link" onClick={() => openFolder(host, anc.id)}>
              {anc.title}
            </button>
          </span>
        ))}
      </span>
      {node && (
        <span className="muted">
          本层 {node.count} 项{node.childCount > 0 ? ` · ${node.childCount} 个子文件夹（共 ${node.totalCount} 项）` : ''}
        </span>
      )}
      <button onClick={() => editGroup(host, view.id, title, [], parentId)}>重命名…</button>
      <button onClick={() => editGroup(host, undefined, '', [], view.id)}>＋ 新建子文件夹</button>
      <button onClick={() => moveFolderDialog(host, view.id, title, parentId)}>移动层级…</button>
    </div>
  );
}

function Membership({ view, host }: ViewProps) {
  const target = typeof view.blocks.collectionMember?.data.group === 'string' ? view.blocks.collectionMember.data.group : undefined;
  const state = useEntityState(target);
  const tree = useTree(host);
  const valid = state.view && !state.view.deletedAt && state.view.blocks.collection;
  const chain = valid && target && tree.data ? ancestorChain(tree.data.nodes, target) : [];
  return (
    <div className="collection-membership">
      {state.status === 'loading' ? (
        <span>读取中…</span>
      ) : valid ? (
        chain.length > 1 ? (
          <span className="collection-membership-path">
            {chain.map((node, i) => (
              <span key={node.id}>
                {i > 0 && ' ／ '}
                <button type="button" className="collection-path-link" onClick={() => openFolder(host, node.id)}>
                  {node.title}
                </button>
              </span>
            ))}
          </span>
        ) : (
          <span>{String(state.view!.blocks.collection.data.title)}</span>
        )
      ) : (
        <span>未归档（原文件夹不可用）</span>
      )}
      {valid && <button onClick={() => host.open(target!)}>打开文件夹</button>}
      <button onClick={() => chooseGroup(host, [view.id])}>更改文件夹</button>
      <button
        onClick={() =>
          void host.core.run('collection', 'move', { ids: [view.id], group: null }).catch(e => host.notify(String(e)))
        }
      >
        移出
      </button>
    </div>
  );
}

export const plugin: UiPlugin = {
  id: 'collection',
  navs: [
    {
      id: 'collection.folders',
      order: 20,
      dropQuery(zone) {
        if (!zone || zone === '$root') return undefined;
        if (zone === '$ungrouped') return { scope: 'content' };
        return { where: [{ op: 'eq', kind: 'collectionMember', field: 'group', value: zone }] };
      },
      Component: FolderTreeNav
    }
  ],
  views: [
    { id: HOME, title: '组', query: { has: ['collection'] }, tab: 'collection.browser', defaultVisible: false, order: 22 },
    { id: UNASSIGNED, title: '未分组', query: { lacks: ['collection'] }, tab: 'collection.browser', defaultVisible: false, order: 23 }
  ],
  tabTypes: [
    {
      id: 'collection.browser',
      key: p => String(p.group ?? (p.ungrouped || p.presetId === UNASSIGNED ? 'ungrouped' : 'home')),
      Title: GroupTitle,
      Component: Browser,
      dropQuery(params, saved, zone) {
        const isCondZone = zone?.trim().startsWith('{');
        const target = !isCondZone && zone ? zone : (typeof params.group === 'string' ? params.group : undefined);
        if (!target) return undefined;
        const baseQuery: Query = {
          where: [{ op: 'eq', kind: 'collectionMember', field: 'group', value: target }]
        };
        if (!isCondZone && zone) return baseQuery;
        return collectionQuery(
          { title: String(params.title ?? '文件夹'), query: baseQuery },
          saved as CollectionState | undefined,
          isCondZone ? zone : undefined
        );
      }
    }
  ],
  covers: [{ priority: 8, match: v => !!v.blocks.collection, Component: Cover }],
  opens: [{ priority: 8, match: v => !!v.blocks.collection, tab: 'collection.browser', params: v => ({ group: v.id, title: String(v.blocks.collection.data.title ?? '文件夹') }) }],
  titles: [
    {
      priority: 8,
      get: v => (v.blocks.collection ? String(v.blocks.collection.data.title) : undefined),
      rename: (views, host) => {
        if (views.length !== 1) {
          host.notify('请逐个重命名文件夹');
          return;
        }
        const parent = typeof views[0].blocks.collection?.data.parent === 'string' ? views[0].blocks.collection.data.parent : null;
        editGroup(host, views[0].id, String(views[0].blocks.collection.data.title), [], parent);
      }
    }
  ],
  actions: [
    {
      id: 'collection.move',
      title: '移动到组…',
      group: 20,
      order: 75,
      when: views => views.length > 0 && views.every(v => !v.deletedAt && !v.blocks.collection),
      run: (views, host) => chooseGroup(host, views.map(v => v.id))
    },
    {
      id: 'collection.create',
      title: '新建组并移入…',
      group: 20,
      order: 76,
      when: views => views.length > 0 && views.every(v => !v.deletedAt && !v.blocks.collection),
      run: (views, host) => editGroup(host, undefined, '', views.map(v => v.id))
    },
    {
      id: 'collection.remove',
      title: '移出组',
      group: 20,
      order: 77,
      when: views => views.length > 0 && views.every(v => !v.deletedAt && !!v.blocks.collectionMember && !v.blocks.collection),
      run: (views, host) =>
        void host.core
          .run('collection', 'move', { ids: views.map(v => v.id), group: null })
          .catch(e => host.notify(String(e)))
    },
    {
      id: 'collection.setCover',
      title: '设为所在文件夹封面',
      group: 20,
      order: 77.5,
      when: views =>
        views.length === 1 &&
        !views[0].deletedAt &&
        !views[0].blocks.collection &&
        typeof views[0].blocks.collectionMember?.data.group === 'string',
      run: (views, host) => {
        const group = String(views[0].blocks.collectionMember?.data.group);
        void host.core
          .run('collection', 'setCover', { id: group, assetId: views[0].id })
          .then(() => host.notify('已设为文件夹封面'))
          .catch(e => host.notify(String(e)));
      }
    },
    {
      id: 'collection.newSubfolder',
      includeContainers: true,
      title: '新建子文件夹…',
      group: 20,
      order: 78,
      when: views => views.length === 1 && !views[0].deletedAt && !!views[0].blocks.collection,
      run: (views, host) => editGroup(host, undefined, '', [], views[0].id)
    },
    {
      id: 'collection.moveFolder',
      includeContainers: true,
      title: '移动文件夹层级…',
      group: 20,
      order: 79,
      when: views => views.length === 1 && !views[0].deletedAt && !!views[0].blocks.collection,
      run: (views, host) => {
        const v = views[0];
        const parent = typeof v.blocks.collection?.data.parent === 'string' ? v.blocks.collection.data.parent : null;
        moveFolderDialog(host, v.id, String(v.blocks.collection?.data.title ?? '文件夹'), parent);
      }
    }
  ],
  sections: [
    {
      id: 'collection.info',
      title: '文件夹信息',
      order: 34,
      kinds: ['collection'],
      match: v => !!v.blocks.collection,
      Component: FolderInfoSection
    },
    {
      id: 'collection.membership',
      title: '所在文件夹',
      order: 35,
      kinds: ['collectionMember'],
      match: v => !!v.blocks.collectionMember,
      Component: Membership
    }
  ]
};
