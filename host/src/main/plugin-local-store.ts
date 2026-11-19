import { PluginLocalFiles, assertLocalValue, validLocalKey, localNamespace } from './plugin-local-files'
export { assertLocalValue } from './plugin-local-files'
import type { LocalScope, LocalServiceContext, LocalValue } from '../plugin-api/local-service'

export interface SecretProtection {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
/** 小型 JSON 配置与凭据，不用作业务缓存。每次读当前文件，多个仓库共享配置不持有旧副本。 */
export function pluginLocalStore(options: {
  directory: string; plugin: string; root: string; active(): boolean; protection: SecretProtection
}): Pick<LocalServiceContext, 'settings' | 'secrets'> {
  if (!validLocalKey(options.plugin)) throw new Error('插件 ID 无效')
  const files = new PluginLocalFiles(options.directory)
  const check = () => { if (!options.active()) throw new Error('[SERVICE_UNAVAILABLE] 服务已停止') }
  const path = (scope: LocalScope, secret: boolean) => {
    check()
    return files.file(options.plugin, localNamespace(scope, options.root), secret ? 'secrets' : 'settings')
  }
  const get = (scope: LocalScope, key: string, secret = false) => {
    if (!validLocalKey(key)) throw new Error('配置键无效')
    return files.read(path(scope, secret)).values[key]
  }
  const put = (scope: LocalScope, key: string, value: LocalValue | undefined, secret = false) => {
    if (!validLocalKey(key)) throw new Error('配置键无效')
    const file = path(scope, secret), doc = files.read(file)
    if (value === undefined) delete doc.values[key]
    else doc.values[key] = value
    files.write(file, doc)
  }
  const protectedStorage = () => {
    check()
    if (!options.protection.available()) throw new Error('[SECRET_STORAGE_UNAVAILABLE] 系统凭据保护不可用，未保存明文')
  }
  return {
    settings: {
      get: (scope, key) => get(scope, key),
      set: (scope, key, value) => { assertLocalValue(value); put(scope, key, value) },
      remove: (scope, key) => put(scope, key, undefined)
    },
    secrets: {
      available: () => { check(); return options.protection.available() },
      has: (scope, key) => get(scope, key, true) !== undefined,
      get: (scope, key) => {
        const value = get(scope, key, true)
        if (value === undefined) return undefined
        protectedStorage()
        if (typeof value !== 'string' || !value || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error('[LOCAL_CONFIG_INVALID] 凭据格式损坏')
        try { return options.protection.decrypt(Buffer.from(value, 'base64')) }
        catch { throw new Error('[SECRET_DECRYPT_FAILED] 无法解密此本机凭据；原记录保留') }
      },
      set: (scope, key, value) => {
        protectedStorage()
        if (typeof value !== 'string' || value.length > 16384) throw new Error('凭据必须为不超过 16384 字符的文本')
        put(scope, key, options.protection.encrypt(value).toString('base64'), true)
      },
      remove: (scope, key) => put(scope, key, undefined, true)
    }
  }
}
