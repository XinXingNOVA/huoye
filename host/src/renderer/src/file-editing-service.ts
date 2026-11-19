import type { FileEditingBridge, FileEditingService } from '../../shared/file-editing'

/** 插件与宿主界面共用同一服务；公共入口不转发替换文件路径等私有参数。 */
export function createFileEditingService(bridge: FileEditingBridge): FileEditingService {
  return {
    list: () => bridge.list(), start: ({ id }) => bridge.start({ id }),
    chooseReplacement: id => bridge.chooseReplacement(id),
    editorOptions: id => bridge.editorOptions(id), chooseEditor: () => bridge.chooseEditor(),
    open: (id, options) => bridge.open(id, options), reveal: id => bridge.reveal(id),
    check: input => bridge.check(input), commit: (id, token) => bridge.commit(id, token),
    discardPrepared: id => bridge.discardPrepared(id), inspectEnd: id => bridge.inspectEnd(id),
    finish: input => bridge.finish(input), discard: (id, token) => bridge.discard(id, token),
    onChanged: listener => bridge.onChanged(listener)
  }
}
