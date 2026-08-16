export const MARKETPLACE_FILENAME = 'marketplace.yaml';

export interface MarketplaceMetadata {
  readonly name: string;
  readonly description?: string;
  readonly organization?: string;
}

export interface MarketplaceMetadataDraft {
  readonly name: string;
  readonly description: string;
  readonly organization: string;
}

export interface MarketplaceDocumentFormat {
  readonly bom: boolean;
  readonly lineEnding: 'lf' | 'crlf';
}

export interface MarketplaceDocumentProblem {
  readonly code:
    | 'MARKETPLACE_MISSING'
    | 'MARKETPLACE_UNAVAILABLE'
    | 'MARKETPLACE_UNSAFE'
    | 'INVALID_ENCODING'
    | 'INVALID_YAML'
    | 'INVALID_METADATA';
  readonly title: string;
  readonly message: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly technicalDetail?: string;
}

export type ReadMarketplaceDocumentResult =
  | {
      readonly status: 'loaded';
      readonly metadata: MarketplaceMetadata;
      readonly draft: MarketplaceMetadataDraft;
      readonly revision: string;
      readonly format: MarketplaceDocumentFormat;
    }
  | {
      readonly status: 'invalid';
      readonly revision: string;
      readonly problem: MarketplaceDocumentProblem;
    }
  | {
      readonly status: 'unavailable';
      readonly problem: MarketplaceDocumentProblem;
    };

export type SaveMarketplaceMetadataResult =
  | {
      readonly status: 'saved';
      readonly metadata: MarketplaceMetadata;
      readonly draft: MarketplaceMetadataDraft;
      readonly revision: string;
      readonly savedAt: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'conflict';
      readonly currentRevision: string;
      readonly message: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'busy';
      readonly message: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'invalid-input';
      readonly issues: readonly {
        readonly field: keyof MarketplaceMetadataDraft;
        readonly message: string;
      }[];
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'invalid-source';
      readonly problem: MarketplaceDocumentProblem;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: boolean;
    };
