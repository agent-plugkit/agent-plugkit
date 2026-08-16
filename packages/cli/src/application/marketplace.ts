import { join } from 'node:path';
import { readMarketplaceCompatibilityView } from './marketplace-document.js';
import {
  MARKETPLACE_FILENAME,
  type MarketplaceMetadata,
} from './marketplace-document-contract.js';

export {
  MARKETPLACE_FILENAME,
  type MarketplaceMetadata,
} from './marketplace-document-contract.js';

/**
 * Compatibility reader for existing CLI and health consumers. Document
 * interpretation is owned by marketplace-document; callers keep their current
 * throw-on-invalid behavior and optional-field compatibility without a
 * parallel YAML parser.
 */
export function readMarketplaceMetadata(rootDirectory: string): MarketplaceMetadata {
  const result = readMarketplaceCompatibilityView(rootDirectory);
  if (result.status === 'loaded') return result.metadata;
  if (
    result.status === 'unavailable' &&
    result.problem.code === 'MARKETPLACE_MISSING'
  ) {
    throw new Error(
      `marketplace.yaml not found: ${join(rootDirectory, MARKETPLACE_FILENAME)}`,
    );
  }
  if (
    result.status === 'invalid' &&
    result.compatibilityFailure === 'non-object'
  ) {
    throw new Error('marketplace.yaml must contain an object');
  }
  if (
    result.status === 'invalid' &&
    result.compatibilityFailure === 'invalid-name'
  ) {
    throw new Error(
      'marketplace.yaml field `name` must be a non-empty string',
    );
  }
  const detail =
    result.problem.technicalDetail === undefined
      ? result.problem.message
      : `${result.problem.message}: ${result.problem.technicalDetail}`;
  throw new Error(`${MARKETPLACE_FILENAME}: ${detail}`);
}
