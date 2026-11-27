export const runtimeTargets = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-arm64', 'linux-x64'] as const
export type RuntimeTarget = typeof runtimeTargets[number]

interface ProviderRuntime {
  program: string
  targets: RuntimeTarget[]
}

export function runtimePath(program: string, target: RuntimeTarget): string {
  return `runtimes/${target}/${program}${target.startsWith('win32-') ? '.exe' : ''}`
}

/** The archive, installer and broker derive all executable paths from the same declarations. */
export function runtimeFiles(runtimes: ProviderRuntime[] = [], target?: string): Set<string> {
  return new Set(runtimes.flatMap(r => r.targets.filter(t => !target || t === target).map(t => runtimePath(r.program, t))))
}
