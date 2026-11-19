/** 从真实命令面板打开入口，避免回归依赖已退役的工具目录按钮。 */
export async function executeUiCommand(js: (code: string) => Promise<any>, id: string): Promise<void> {
  await js(`document.querySelector('[aria-label="打开命令面板"]').click()`)
  const ready = async (code: string) => {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 80)) }
    throw new Error('命令未就绪：' + id)
  }
  const selector = JSON.stringify(`[data-command-id="${id}"]`)
  await ready(`!!document.querySelector(${selector})`)
  await js(`document.querySelector(${selector}).click()`)
  await ready(`!document.querySelector('.command-palette')`)
}
