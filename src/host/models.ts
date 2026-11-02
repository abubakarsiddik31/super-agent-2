/**
 * The model service of the plain Node host.
 *
 * The DeepSeek Harness resolves a route through its own provider. A standalone host has no provider: the coding-agent CLI
 * behind the runner chooses the model, and the host only checks that a configured route names one.
 */
import type { ModelCatalog, ModelInfo, ModelRoute, ModelSelection } from '../runner/port.ts'

export interface NodeModelOptions {
  /** The models the configured CLIs may use, as the panel shows them. */
  readonly catalog?: ModelCatalog
}

/** A model service that accepts any route the operator configured and knows no provider of its own. */
export function nodeModels(options: NodeModelOptions = {}): ModelInfo {
  const catalog = options.catalog ?? {
    default: { provider: 'cli', model: 'default' },
    routableProviders: ['cli'],
    groups: [{ id: 'cli', name: 'The coding-agent CLI', models: [{ id: 'default', name: 'The CLI\'s own default model' }] }],
    failures: [],
  }
  return {
    async resolve(route: ModelRoute): Promise<ModelSelection> {
      if (!route.provider || !route.model) throw new Error('A model route needs a provider and a model')
      return { provider: route.provider, model: route.model, ...route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {} }
    },
    catalog: async () => catalog,
  }
}
