import { createContext, useContext } from 'react'
/** Portal 的显示文档；业务仍在原运行环境内，不复制插件服务。 */
export const UiDocumentContext = createContext<Document | undefined>(undefined)
export const useUiDocument = () => useContext(UiDocumentContext) ?? document
