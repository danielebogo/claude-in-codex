// Pure model-data validation shared by the server and installer.
import fs from 'node:fs';

export function modelsFromConfig(user) {
  const models = user.models === undefined ? JSON.parse(fs.readFileSync(new URL('./models.json', import.meta.url), 'utf8')) : user.models;
  const slugs = new Set();
  if (!Array.isArray(models)) throw new Error('Expected a model list');
  for (const model of models) {
    const provider = model?.provider ?? 'claude';
    const nativeModel = model?.model ?? (provider === 'claude' ? model?.claudeModel : undefined);
    if (!model || !['claude', 'grok'].includes(provider) || ['slug', 'displayName'].some((key) => typeof model[key] !== 'string' || !model[key].trim()) || typeof nativeModel !== 'string' || !nativeModel.trim() || slugs.has(model.slug)) {
      throw new Error('Each model needs a unique slug, displayName, supported provider (claude or grok), and native model (model, or legacy claudeModel).');
    }
    if (model.hidden !== undefined && typeof model.hidden !== 'boolean') throw new Error('Model hidden must be a boolean');
    for (const key of ['discovered', 'discoveryHidden']) if (model[key] !== undefined && typeof model[key] !== 'boolean') throw new Error(`Model ${key} must be a boolean`);
    if (model.reasoningEfforts !== undefined && (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.some((effort) => !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)))) throw new Error('Model reasoningEfforts must be a list of supported effort levels');
    slugs.add(model.slug);
  }
  return models;
}
