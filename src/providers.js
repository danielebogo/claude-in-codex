// Provider dispatch reuses native process/tool lifecycle while keeping CLI protocols and durable sessions separate.
import { fileURLToPath } from 'node:url';
import { runClaudeTurn, compactSession, hasActiveClaudeTurns } from './claudeRunner.js';

// Failure modes: unsupported provider, missing native model, foreign session ownership,
// and a Grok fork compaction that cannot safely mutate its parent's native session.
export function providerForModel(model) {
  const provider = model.provider ?? 'claude';
  if (!['claude', 'grok'].includes(provider)) throw new Error(`Unsupported provider: ${provider}.`);
  return provider;
}

/** Leaves existing Claude state keys intact and isolates other providers even when native IDs coincide. */
export function providerState(state, provider) {
  if (provider === 'claude') return state;
  if (provider !== 'grok') throw new Error(`Unsupported provider: ${provider}.`);
  const key = (sid) => sid == null ? sid : `${provider}:${sid}`;
  return {
    isLatestTurn: (sid, turnId) => state.isLatestTurn(key(sid), turnId),
    ownerThread: (sid) => state.ownerThread(key(sid)),
    agentMessageIds: (sid) => state.agentMessageIds(key(sid)),
    recordAgentMessageIds: (sid, ids) => state.recordAgentMessageIds(key(sid), ids),
    recordTurn: (sid, turnId, threadId, ids) => state.recordTurn(key(sid), turnId, threadId, ids),
    setContextWindow: (model, size) => state.setContextWindow(model, size),
    contextWindow: (model) => state.contextWindow(model),
  };
}

/** Adapts only the executable, environment and model; auth, streaming and bounded admission remain shared. */
export function nativeRuntime(config, modelCfg) {
  const provider = providerForModel(modelCfg);
  const model = modelCfg.model ?? modelCfg.claudeModel;
  if (typeof model !== 'string' || !model.trim()) throw new Error(`Missing native model for ${provider} route ${modelCfg.slug}.`);
  return {
    config: {
      ...config,
      nativeProvider: provider,
      ...(provider === 'grok' ? {
        claudePath: fileURLToPath(new URL('./grokBridgeCli.js', import.meta.url)),
        nativeEnvironment: { CODEX_BRIDGE_GROK_PATH: config.grokPath || 'grok' },
      } : {}),
    },
    modelCfg: { ...modelCfg, claudeModel: model },
  };
}

export function runNativeTurn(args) {
  const runtime = nativeRuntime(args.config, args.modelCfg);
  return runClaudeTurn({ ...args, ...runtime, state: providerState(args.state, providerForModel(args.modelCfg)) });
}

export function compactNativeSession(args) {
  if (providerForModel(args.modelCfg) === 'grok' && args.fork) {
    return Promise.resolve({ ok: false, sessionId: null, error: 'Grok cannot compact a fork before its first message. Send a normal Grok message to create its separate session first.' });
  }
  return compactSession({ ...args, ...nativeRuntime(args.config, args.modelCfg) });
}

export const hasActiveNativeTurns = hasActiveClaudeTurns;
