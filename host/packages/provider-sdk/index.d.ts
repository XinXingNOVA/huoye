/** One invocation in a trusted Node worker. File contracts receive the resolved, accepted source. */
export interface ProviderContext {
  readonly sourcePath?: string
  readonly signal: AbortSignal
  progress(fraction: number): void
  /** Run one declared local executable. Returns bounded stdout. */
  run(program: string, args: readonly string[]): Promise<Uint8Array>
}
type ContractMap = Record<string, { input: unknown; output: unknown }>
type UntypedContracts = Record<string, { input: Readonly<Record<string, unknown>>; output: unknown }>

/** Author contracts in capabilities v2 receive params directly. In v1 they receive the request envelope.
 * File sources are resolved through context.sourcePath. Image contracts return a Uint8Array.
 * Supply a contract map to type each handler. */
export interface CapabilityProvider<C extends ContractMap = UntypedContracts> {
  readonly id: string
  readonly handlers: { readonly [K in keyof C]: (input: C[K]['input'], context: ProviderContext) => C[K]['output'] | Promise<C[K]['output']> }
}
