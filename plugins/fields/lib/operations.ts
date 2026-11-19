import { z } from 'zod'
import type { OperationDefinition } from '@resource-manager/plugin-api/operations'

const id = z.string().min(1).max(200), title = z.string().trim().min(1).max(200)
const template = z.object({ template: id }).strict()
const field = template.extend({ field: id }).strict()
const type = z.enum(['text', 'longtext', 'number', 'select', 'multi', 'date', 'checkbox', 'rating', 'url'])
export const setValuesSchema = template.extend({
  items: z.array(z.object({
    id, expectedSeq: z.number().int().nonnegative(),
    values: z.record(z.string(), z.union([z.string().max(100000), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(1000), z.null()]))
  }).strict()).min(1).max(100)
}).strict()

export const operations: OperationDefinition[] = [
  { name: 'fields_create_template', effect: 'structure', title: '新建字段模板', command: 'createTemplate', input: z.object({ title }).strict(), description: '创建空模板，返回 template 身份与 kind；再用 fields_add_field 定义字段。模板和字段定义可通过 search_items（role:management, has:[template]）及 read_item 读取。' },
  { name: 'fields_rename_template', effect: 'structure', title: '重命名字段模板', command: 'renameTemplate', input: template.extend({ title }).strict(), description: '修改模板名称，保留身份、字段和素材值。' },
  { name: 'fields_add_field', effect: 'structure', title: '添加字段', command: 'addField', input: template.extend({ title, type }).strict(), description: '在模板中添加字段，返回稳定 field ID；select/multi 需用 fields_add_option 设置允许值。' },
  { name: 'fields_rename_field', effect: 'structure', title: '重命名字段', command: 'renameField', input: field.extend({ title }).strict(), description: '按稳定 field ID 修改显示名称，已有值保持。' },
  { name: 'fields_add_option', effect: 'structure', title: '添加字段选项', command: 'addOption', input: field.extend({ option: title }).strict(), description: '为单选或多选字段添加允许值；不修改素材已有值。' },
  { name: 'fields_set_values', effect: 'data', title: '填写字段值', command: 'setValues', input: setValuesSchema, description: '按已有模板批量填写最多100项素材，values 使用稳定 field ID，未提供字段保留，null 清除该字段。先 read_item 读取 tpl:<template> 块 seq；expectedSeq 为该序号，无块时为0。校验选项、类型、素材状态和并发修改，整批成功或失败，可撤销；不允许借填值新增字段或选项。' }
]
