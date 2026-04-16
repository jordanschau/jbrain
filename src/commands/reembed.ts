/**
 * gbrain reembed — rebuild the vector column at the active provider's dimension
 * and re-embed all chunks.
 *
 * Use after switching embedding providers/models (e.g. OpenAI 1536d → Ollama 768d)
 * or to refresh embeddings against an upgraded model.
 *
 *   gbrain reembed              # if dimensions match: just re-embed all
 *                               # if dimensions differ: drop+recreate column, then re-embed
 *   gbrain reembed --dry-run    # show what would change without modifying anything
 *   gbrain reembed --force      # rebuild column even if dimensions match
 */

import type { BrainEngine } from '../core/engine.ts';
import { getEmbeddingProvider } from '../core/providers/factory.ts';
import { runEmbed } from './embed.ts';

export async function runReembed(engine: BrainEngine, args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const provider = getEmbeddingProvider();
  const targetDim = provider.dimensions;
  const targetModel = provider.modelName;

  const currentDimStr = await engine.getConfig('embedding_dimensions');
  const currentModel = await engine.getConfig('embedding_model');
  const currentDim = currentDimStr ? Number(currentDimStr) : null;

  console.log(`Current: ${currentModel ?? '(unset)'} @ ${currentDim ?? '(unset)'}d`);
  console.log(`Target:  ${targetModel} @ ${targetDim}d`);

  const needsRebuild = force || currentDim !== targetDim;

  if (!needsRebuild) {
    console.log('Dimensions match. Re-embedding all chunks against active provider.');
    if (dryRun) {
      console.log('--dry-run: skipping embed.');
      return;
    }
    if (currentModel !== targetModel) {
      await engine.setConfig('embedding_model', targetModel);
    }
    await runEmbed(engine, ['--all']);
    return;
  }

  console.log(`Rebuilding embedding column: vector(${currentDim ?? '?'}) → vector(${targetDim}).`);
  if (dryRun) {
    console.log('--dry-run: skipping DDL and embed.');
    return;
  }

  // Drop existing HNSW index + column, recreate at target dim, recreate index.
  // pgvector requires HNSW indexes to match the column dimension exactly.
  await engine.runMigration(0, `
    DROP INDEX IF EXISTS idx_chunks_embedding;
    ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding;
    ALTER TABLE content_chunks ADD COLUMN embedding vector(${targetDim});
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding
      ON content_chunks USING hnsw (embedding vector_cosine_ops);
  `);

  // Clear embedded_at so all chunks are picked up by --stale and --all.
  await engine.runMigration(0, `UPDATE content_chunks SET embedded_at = NULL, model = '${targetModel.replace(/'/g, "''")}';`);

  await engine.setConfig('embedding_dimensions', String(targetDim));
  await engine.setConfig('embedding_model', targetModel);

  console.log('Column rebuilt. Re-embedding all chunks.');
  await runEmbed(engine, ['--all']);
}
