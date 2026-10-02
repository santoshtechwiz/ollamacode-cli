export function applyRuntimeConfig(config: any, workspace: any): any {
  if (workspace.contextWindow) config.contextWindow = Number(workspace.contextWindow);
  if (workspace.maxTokens) config.maxTokens = Number(workspace.maxTokens);

  if (workspace.thinkingEnabled !== undefined) config.thinkingEnabled = workspace.thinkingEnabled;
  if (workspace.supportsThinking !== undefined) config.supportsThinking = workspace.supportsThinking;

  config.reasoningLeaks = config.reasoningLeaks === true || workspace.reasoningLeaks === true;
  if (workspace.tokensPerSec !== undefined) config.tokensPerSec = workspace.tokensPerSec;
  return config;
}
