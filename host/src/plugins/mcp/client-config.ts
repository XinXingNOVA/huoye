/** 同一份宿主 stdio 配置，按客户端所需格式呈现。 */
export function clientConfig(config: string, format: 'json' | 'toml') {
  if (format === 'json') return config
  const server: { command: string; args: string[]; env: Record<string, string> } = JSON.parse(config).mcpServers['huoye']
  return [
    '[mcp_servers.huoye]',
    'command = ' + JSON.stringify(server.command),
    'args = ' + JSON.stringify(server.args),
    '',
    '[mcp_servers.huoye.env]',
    ...Object.entries(server.env).map(([key, value]) => JSON.stringify(key) + ' = ' + JSON.stringify(value))
  ].join('\n')
}
